import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueRelations, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { documentService } from "../services/documents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWithBoardAccess } from "./helpers/route-test-harness.js";

// Only the provider is substituted. Routes, authorization, wake persistence,
// heartbeat admission/claim/preflight, task locks and response delivery are real.
// The registered adapter exercises the legacy provider boundary; this does not
// claim to certify a live native provider protocol or remote runner deployment.
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const adapterType = "interaction_responder_journey_test";
type Db = ReturnType<typeof createDb>;
type Run = typeof heartbeatRuns.$inferSelect;
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out awaiting ${label}`);
}

describePostgres("pending interaction reviewer assembled journey", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const starts = new Map<string, Run>();
  const releases = new Map<string, ReturnType<typeof latch<void>>>();

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "paperclip-review-journey-"));
    process.env.PAPERCLIP_HOME = home;
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-review-journey-db-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async input => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
        expect(run.status).toBe("running"); // The actual queue claim has committed.
        starts.set(input.runId, run);
        const context = input.context as Record<string, unknown>;
        const cardId = (context.interactionResponder as { interactionId?: string } | undefined)?.interactionId ?? context.interactionId;
        const release = releases.get(input.runId) ?? (typeof cardId === "string" ? releases.get(`card:${cardId}`) : undefined) ?? releases.get(input.agent.id);
        if (release) await release.promise;
        await input.onProviderStopped?.();
        return { exitCode: 0, signal: null, timedOut: false, summary: "Deterministic fixture provider completed." };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    for (const release of releases.values()) release.resolve();
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    const board = await seedCompanyWithBoardAccess(db, "Interaction journey");
    const reviewer = randomUUID(), architect = randomUUID(), other = randomUUID();
    const parent = randomUUID(), child = randomUUID();
    await db.insert(authUsers).values({ id: board.userId, name: "Board", email: `${board.userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: board.userId }).where(eq(companies.id, board.companyId));
    for (const [id, name] of [[reviewer, "Reviewer"], [architect, "Architect"], [other, "Other"]]) {
      await db.insert(agents).values({ id, companyId: board.companyId, name, role: "engineer", status: "idle", adapterType,
        adapterConfig: { cwd: home }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
      await db.insert(companyMemberships).values({ companyId: board.companyId, principalType: "agent", principalId: id, membershipRole: "member" });
    }
    await db.insert(issues).values([
      { id: parent, companyId: board.companyId, title: "Parent waits for completed preparation", status: "blocked", assigneeAgentId: reviewer, responsibleUserId: board.userId, issueNumber: 1 },
      { id: child, companyId: board.companyId, title: "Architect-owned preparation", status: "in_review", parentId: parent, assigneeAgentId: architect, responsibleUserId: board.userId, issueNumber: 2 },
    ]);
    await db.insert(issueRelations).values({ companyId: board.companyId, issueId: child, relatedIssueId: parent, type: "blocks", createdByUserId: board.userId });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const runId = req.header("X-Fixture-Run-Id");
      req.actor = runId ? { type: "agent", source: "agent_jwt", companyId: board.companyId,
        agentId: req.header("X-Fixture-Agent-Id") ?? reviewer, runId } : { ...board.actor, source: "session" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", agentRoutes(db, {}));
    app.use(errorHandler);
    return { ...board, reviewer, architect, other, parent, child, app };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function createQuestion(f: Fixture, resolverPolicy = "not_creator") {
    const response = await request(f.app).post(`/api/issues/${f.child}/interactions`).send({
      kind: "ask_user_questions", resolverPolicy, addresseeAgentId: f.reviewer,
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which authorized scope?", selectionMode: "single", required: true,
        options: [{ id: "existing", label: "Existing scope" }] }] },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as typeof issueThreadInteractions.$inferSelect;
  }
  async function createConfirmation(f: Fixture) {
    const { document } = await documentService(db).upsertIssueDocument({ issueId: f.child, key: "plan", format: "markdown", body: "Reviewed revision", createdByUserId: f.userId });
    const response = await request(f.app).post(`/api/issues/${f.child}/interactions`).send({ kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: f.reviewer,
      payload: { version: 1, prompt: "Accept this exact revision?", target: { type: "issue_document", issueId: f.child,
        documentId: document.id, key: "plan", revisionId: document.latestRevisionId, revisionNumber: document.latestRevisionNumber } } });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { card: response.body as typeof issueThreadInteractions.$inferSelect, document };
  }
  async function reviewRun(f: Fixture, interactionId: string) {
    return eventually(async () => {
      const rows = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.reviewer)));
      return rows.find(run => (run.contextSnapshot as Record<string, unknown> | null)?.interactionId === interactionId);
    }, "persisted addressed-reviewer wake");
  }
  async function assertOwnership(f: Fixture) {
    const [child] = await db.select().from(issues).where(eq(issues.id, f.child));
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
    expect(child.assigneeAgentId).toBe(f.architect);
    expect(parent.assigneeAgentId).toBe(f.reviewer);
    expect(parent.status).toBe("blocked");
    expect(await db.select().from(issueRelations).where(and(eq(issueRelations.issueId, f.child), eq(issueRelations.relatedIssueId, f.parent)))).toHaveLength(1);
  }

  it.each(["question", "confirmation"] as const)("claims the non-assignee reviewer for a %s, resolves the real card, and resumes its Architect while the parent legitimately waits", async kind => {
    const f = await fixture();
    const reviewerRelease = latch<void>();
    releases.set(f.reviewer, reviewerRelease);
    try {
      const card = kind === "question" ? await createQuestion(f) : (await createConfirmation(f)).card;
      const queued = await reviewRun(f, card.id);
      const running = await eventually(async () => {
        const started = starts.get(queued.id);
        if (started) return started;
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
        if (["cancelled", "failed", "skipped"].includes(current.status)) {
          throw new Error(`Reviewer never reached provider after the real queue claim: ${JSON.stringify({
            status: current.status, errorCode: current.errorCode, error: current.error,
          })}`);
        }
        return undefined;
      }, "actual claimed reviewer provider start");
      expect(running.agentId).toBe(f.reviewer);
      expect(running.contextSnapshot).toMatchObject({ issueId: f.child, interactionId: card.id, wakeReason: "interaction_pending", source: "issue.interaction.created" });
      await assertOwnership(f);
      const resolution = kind === "question" ? "respond" : "accept";
      const answered = await request(f.app).post(`/api/issues/${f.child}/interactions/${card.id}/${resolution}`)
        .set("X-Fixture-Run-Id", running.id).set("X-Fixture-Agent-Id", f.reviewer)
        .send(kind === "question" ? { answers: [{ questionId: "scope", optionIds: ["existing"] }] } : {});
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      const [persisted] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(persisted).toMatchObject({ status: kind === "question" ? "answered" : "accepted", resolvedByAgentId: f.reviewer, resolvedByRunId: running.id });
      reviewerRelease.resolve();
      releases.delete(f.reviewer);
      await eventually(async () => [...starts.values()].find(run => run.companyId === f.companyId && run.agentId === f.architect), "Architect provider continuation");
      await heartbeat.drainActiveRunExecutions();
      await assertOwnership(f);
    } finally { reviewerRelease.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  async function createUnstartedQuestion(f: Fixture) {
    // Keep the agent invokable for real card-creation validation, but suppress
    // its automatic turn while constructing the old-attempt/operator fixture.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewer));
    const card = await createQuestion(f);
    await heartbeat.drainActiveRunExecutions();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewer));
    return card;
  }

  it("uses a new board interaction-response intent without rewriting the old cancelled review receipt", async () => {
    const f = await fixture();
    const card = await createUnstartedQuestion(f);
    const oldRunId = randomUUID(), oldWakeId = randomUUID();
    const finishedAt = new Date("2026-11-01T13:12:54.061Z");
    await db.insert(agentWakeupRequests).values({ id: oldWakeId, companyId: f.companyId, agentId: f.reviewer,
      source: "automation", triggerDetail: "system", reason: "interaction_pending", status: "skipped",
      idempotencyKey: `historical-093:${card.id}`, runId: oldRunId, finishedAt,
      payload: { issueId: f.child, interactionId: card.id }, error: "issue_assignee_changed" });
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId: f.companyId, agentId: f.reviewer,
      status: "cancelled", startedAt: null, finishedAt, wakeupRequestId: oldWakeId,
      invocationSource: "automation", triggerDetail: "system", responsibleUserId: f.userId,
      errorCode: "issue_assignee_changed", error: "The old queued turn never started",
      contextSnapshot: { issueId: f.child, interactionId: card.id, wakeReason: "interaction_pending", source: "issue.interaction.created" } });
    const [oldRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRunId));
    const [oldWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, oldWakeId));
    const release = latch<void>();
    releases.set(f.reviewer, release);
    try {
      const intent = { source: "on_demand", triggerDetail: "manual", reason: "interaction_response_requested",
        idempotencyKey: `operator-response:${card.id}:first`, payload: { issueId: f.child, interactionId: card.id } };
      const response = await request(f.app).post(`/api/agents/${f.reviewer}/wakeup`).send(intent);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(response.body.id).not.toBe(oldRunId);
      const running = await eventually(async () => starts.get(response.body.id), "new operator-requested reviewer provider start");
      expect(running.contextSnapshot).toMatchObject({ issueId: f.child, source: "agent.wakeup.interaction_requested", interactionResponder: { purpose: "interaction_responder", interactionId: card.id } });
      await assertOwnership(f);
      // The same operator intent is idempotent; it is not permission to replay
      // either the old failed turn or another independent provider execution.
      const duplicate = await request(f.app).post(`/api/agents/${f.reviewer}/wakeup`).send(intent);
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(202);
      // The public API may acknowledge an already-running intent with its
      // normal skipped response instead of returning the run object. Prove
      // idempotence in durable state, not from that presentation shape.
      const [firstIntent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, running.wakeupRequestId!));
      expect(firstIntent.idempotencyKey).toBeTruthy();
      const intentReceipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.reviewer),
        eq(agentWakeupRequests.idempotencyKey, firstIntent.idempotencyKey!),
      ));
      expect(intentReceipts, JSON.stringify({ response: duplicate.body, receipts: intentReceipts })).toHaveLength(1);
      expect(intentReceipts[0].runId).toBe(running.id);
      const operatorRuns = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.reviewer))))
        .filter(r => (r.contextSnapshot as Record<string, unknown> | null)?.source === "agent.wakeup.interaction_requested");
      expect(operatorRuns.map(r => r.id)).toEqual([running.id]);
      if (duplicate.body.id !== undefined) expect(duplicate.body.id).toBe(running.id);
      const answered = await request(f.app).post(`/api/issues/${f.child}/interactions/${card.id}/respond`)
        .set("X-Fixture-Run-Id", running.id).set("X-Fixture-Agent-Id", f.reviewer)
        .send({ answers: [{ questionId: "scope", optionIds: ["existing"] }] });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      release.resolve(); releases.delete(f.reviewer);
      await eventually(async () => [...starts.values()].find(run => run.companyId === f.companyId && run.agentId === f.architect), "Architect after operator repair");
      await heartbeat.drainActiveRunExecutions();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRunId)))[0]).toEqual(oldRun);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, oldWakeId)))[0]).toEqual(oldWake);
      const [resolved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(resolved).toMatchObject({ status: "answered", resolvedByAgentId: f.reviewer, resolvedByRunId: running.id });
      await assertOwnership(f);
    } finally { release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  it.each(["agent_caller", "stale_card", "human_only", "wrong_recipient", "missing_intent_key"] as const)("refuses an operator response request with %s without launching a provider", async invalid => {
    const f = await fixture();
    const card = await createUnstartedQuestion(f);
    if (invalid === "stale_card") await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
    if (invalid === "human_only") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, card.id));
    const actorRunId = randomUUID();
    if (invalid === "agent_caller") await db.insert(heartbeatRuns).values({ id: actorRunId, companyId: f.companyId,
      agentId: f.reviewer, status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: f.parent } });
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const target = invalid === "wrong_recipient" ? f.other : f.reviewer;
    const pending = request(f.app).post(`/api/agents/${target}/wakeup`);
    if (invalid === "agent_caller") pending.set("X-Fixture-Run-Id", actorRunId).set("X-Fixture-Agent-Id", f.reviewer);
    const response = await pending.send({ source: "on_demand", triggerDetail: "manual", reason: "interaction_response_requested",
      ...(invalid === "missing_intent_key" ? {} : { idempotencyKey: `invalid-operator:${card.id}` }),
      payload: { issueId: f.child, interactionId: card.id } });
    expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(before.length);
    expect([...starts.values()].filter(run => run.companyId === f.companyId)).toHaveLength(0);
    if (invalid === "agent_caller") await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, actorRunId));
    await assertOwnership(f);
  }, 15_000);

  it("keeps null source execution locks while an addressed same-assignee response-only turn runs", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.reviewer }).where(eq(issues.id, f.child));
    const release = latch<void>(); releases.set(f.reviewer, release);
    try {
      const card = await createQuestion(f); // Board creator is a different actor.
      const run = await reviewRun(f, card.id);
      const running = await eventually(async () => starts.get(run.id), "same-assignee response-only provider");
      expect(running.contextSnapshot).toMatchObject({ interactionResponder: { purpose: "interaction_responder", interactionId: card.id } });
      const [source] = await db.select().from(issues).where(eq(issues.id, f.child));
      expect(source).toMatchObject({ assigneeAgentId: f.reviewer, status: "in_review", executionRunId: null, checkoutRunId: null });
      const answered = await request(f.app).post(`/api/issues/${f.child}/interactions/${card.id}/respond`)
        .set("X-Fixture-Run-Id", running.id).set("X-Fixture-Agent-Id", f.reviewer)
        .send({ answers: [{ questionId: "scope", optionIds: ["existing"] }] });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      const [afterAnswer] = await db.select().from(issues).where(eq(issues.id, f.child));
      expect(afterAnswer).toMatchObject({ assigneeAgentId: f.reviewer, checkoutRunId: null });
      if (afterAnswer.executionRunId !== null) {
        // A resolved card may reserve a legitimate deliverable continuation,
        // but must never install the bounded responder as source executor.
        expect(afterAnswer.executionRunId).not.toBe(running.id);
        const [continuation] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, afterAnswer.executionRunId));
        expect(continuation).toMatchObject({ agentId: f.reviewer, contextSnapshot: {
          issueId: f.child, interactionId: card.id, wakeReason: "issue_commented", source: "issue.interaction.respond",
        } });
        expect((continuation.contextSnapshot as Record<string, unknown>).interactionResponder).toBeUndefined();
      }
      release.resolve(); releases.delete(f.reviewer);
      await heartbeat.drainActiveRunExecutions();
    } finally { release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  it("answers on a blocked source without resuming its deliverable until its real prerequisite is done", async () => {
    const f = await fixture(), prerequisite = randomUUID();
    await db.insert(issues).values({ id: prerequisite, companyId: f.companyId, title: "Real source prerequisite", status: "todo", assigneeAgentId: f.other, responsibleUserId: f.userId, issueNumber: 3 });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: prerequisite, relatedIssueId: f.child, type: "blocks", createdByUserId: f.userId });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.child));
    const release = latch<void>(); releases.set(f.reviewer, release);
    try {
      const card = await createQuestion(f), run = await reviewRun(f, card.id);
      const running = await eventually(async () => starts.get(run.id), "reviewer on blocked source");
      expect((await db.select().from(issues).where(eq(issues.id, f.child)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: f.architect, executionRunId: null, checkoutRunId: null });
      const response = await request(f.app).post(`/api/issues/${f.child}/interactions/${card.id}/respond`)
        .set("X-Fixture-Run-Id", running.id).set("X-Fixture-Agent-Id", f.reviewer)
        .send({ answers: [{ questionId: "scope", optionIds: ["existing"] }] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      release.resolve(); releases.delete(f.reviewer);
      await heartbeat.drainActiveRunExecutions();
      expect([...starts.values()].some(r => r.companyId === f.companyId && r.agentId === f.architect)).toBe(false);
      expect((await db.select().from(issues).where(eq(issues.id, f.child)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: f.architect });
      expect(await db.select().from(issueRelations).where(and(eq(issueRelations.issueId, prerequisite), eq(issueRelations.relatedIssueId, f.child)))).toHaveLength(1);
      const completed = await request(f.app).patch(`/api/issues/${prerequisite}`).send({ status: "done" });
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      await eventually(async () => [...starts.values()].find(r => r.companyId === f.companyId && r.agentId === f.architect), "Architect only after prerequisite completion");
      await heartbeat.drainActiveRunExecutions();
      await assertOwnership(f);
    } finally { release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  it("keeps different pending question and confirmation cards on the same issue in separate run receipts", async () => {
    const f = await fixture(), firstRelease = latch<void>(), secondRelease = latch<void>();
    releases.set(f.reviewer, firstRelease);
    let secondRunId: string | undefined;
    try {
      const question = await createQuestion(f), firstRun = await reviewRun(f, question.id);
      const first = await eventually(async () => starts.get(firstRun.id), "first card reviewer");
      const { card: confirmation } = await createConfirmation(f);
      const secondReceipt = await eventually(async () => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.reviewer),
        eq(agentWakeupRequests.idempotencyKey, `interaction:${confirmation.id}:pending`),
      )))[0], "second independent durable card receipt");
      expect(secondReceipt.id).not.toBe(first.wakeupRequestId);
      expect(secondReceipt.payload).toMatchObject({ issueId: f.child, interactionId: confirmation.id });
      if (secondReceipt.runId !== null) expect(secondReceipt.runId).not.toBe(first.id);
      // Busy reviewers can retain a deferred receipt until their slot clears.
      releases.set(`card:${confirmation.id}`, secondRelease);
      const answer = await request(f.app).post(`/api/issues/${f.child}/interactions/${question.id}/respond`)
        .set("X-Fixture-Run-Id", first.id).set("X-Fixture-Agent-Id", f.reviewer)
        .send({ answers: [{ questionId: "scope", optionIds: ["existing"] }] });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0].status).toBe("pending");
      firstRelease.resolve(); releases.delete(f.reviewer);
      const secondRun = await reviewRun(f, confirmation.id); secondRunId = secondRun.id;
      expect(secondRun.id).not.toBe(first.id);
      const second = await eventually(async () => starts.get(secondRun.id), "second independent card reviewer");
      expect(second.contextSnapshot).toMatchObject({ interactionId: confirmation.id, interactionResponder: { interactionId: confirmation.id } });
      const accepted = await request(f.app).post(`/api/issues/${f.child}/interactions/${confirmation.id}/accept`)
        .set("X-Fixture-Run-Id", second.id).set("X-Fixture-Agent-Id", f.reviewer).send({});
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id)))[0])
        .toMatchObject({ status: "answered", resolvedByRunId: first.id });
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0])
        .toMatchObject({ status: "accepted", resolvedByRunId: second.id });
      secondRelease.resolve(); releases.delete(`card:${confirmation.id}`);
      await heartbeat.drainActiveRunExecutions();
      await assertOwnership(f);
    } finally {
      firstRelease.resolve(); secondRelease.resolve(); releases.delete(f.reviewer);
      if (secondRunId) releases.delete(secondRunId);
      for (const [key, gate] of releases) if (gate === secondRelease) releases.delete(key);
    }
  }, 30_000);

  // Hold an ordinary provider turn so the next interaction wake is genuinely
  // queued. Mutations occur after enqueue and before the real queue claim.
  async function holdReviewer(f: Fixture) {
    const hold = randomUUID();
    await db.insert(issues).values({ id: hold, companyId: f.companyId, title: "Controlled provider occupancy", status: "todo", assigneeAgentId: f.reviewer, responsibleUserId: f.userId, issueNumber: 3 });
    const release = latch<void>();
    releases.set(f.reviewer, release);
    const run = await heartbeat.wakeup(f.reviewer, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: hold }, contextSnapshot: { issueId: hold } });
    expect(run).not.toBeNull();
    await eventually(async () => starts.get(run!.id), "occupying provider turn");
    return { release, run: run! };
  }

  it.each(["resolved", "wrong_addressee", "human_only", "cross_company"] as const)("revalidates %s after enqueue instead of executing an obsolete reviewer turn", async changed => {
    const f = await fixture();
    const held = await holdReviewer(f);
    try {
      const card = await createQuestion(f);
      const queued = await reviewRun(f, card.id);
      expect(queued.status).toBe("queued");
      if (changed === "resolved") await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
      if (changed === "wrong_addressee") await db.update(issueThreadInteractions).set({ addresseeAgentId: f.other }).where(eq(issueThreadInteractions.id, card.id));
      if (changed === "human_only") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, card.id));
      if (changed === "cross_company") {
        const foreign = await seedCompanyWithBoardAccess(db, "Foreign company");
        await db.update(issueThreadInteractions).set({ companyId: foreign.companyId }).where(eq(issueThreadInteractions.id, card.id));
      }
      held.release.resolve(); releases.delete(f.reviewer);
      await heartbeat.drainActiveRunExecutions();
      expect(starts.has(queued.id)).toBe(false);
      const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
      expect(settled).toMatchObject({ status: "cancelled", errorCode: "interaction_response_not_current" });
      await assertOwnership(f);
    } finally { held.release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  it("does not fall back to normal assignee execution when a same-owner response card is revoked in the queue", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.reviewer }).where(eq(issues.id, f.child));
    const held = await holdReviewer(f);
    try {
      const card = await createQuestion(f), queued = await reviewRun(f, card.id);
      expect(queued.status).toBe("queued");
      await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
      held.release.resolve(); releases.delete(f.reviewer);
      await heartbeat.drainActiveRunExecutions();
      expect(starts.has(queued.id)).toBe(false);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "interaction_response_not_current" });
      expect((await db.select().from(issues).where(eq(issues.id, f.child)))[0])
        .toMatchObject({ assigneeAgentId: f.reviewer, executionRunId: null, checkoutRunId: null });
    } finally { held.release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);

  it("rejects a confirmation whose document revision changes while the reviewer is queued", async () => {
    const f = await fixture();
    const held = await holdReviewer(f);
    try {
      const { card, document } = await createConfirmation(f);
      const queued = await reviewRun(f, card.id);
      await documentService(db).upsertIssueDocument({ issueId: f.child, key: "plan", format: "markdown", body: "Changed revision", baseRevisionId: document.latestRevisionId, createdByUserId: f.userId });
      held.release.resolve(); releases.delete(f.reviewer);
      await heartbeat.drainActiveRunExecutions();
      expect(starts.has(queued.id)).toBe(false);
      await assertOwnership(f);
    } finally { held.release.resolve(); releases.delete(f.reviewer); }
  }, 30_000);
});
