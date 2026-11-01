import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, agents, issues, issueThreadInteractions, agentWakeupRequests, documents, issueDocuments, budgetPolicies, costEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { interactionWakeDeliveryService, pendingInteractionWakeKey } from "../services/interaction-wake-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("durable ordinary interaction wake delivery", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-interaction-wakes-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(status = "pending") {
    const companyId = randomUUID(), owner = randomUUID(), reviewer = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake recovery", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(agents).values([owner, reviewer].map(id => ({ id, companyId, name: id === owner ? "Architect" : "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Existing preparation", status: "in_progress", assigneeAgentId: owner });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", status,
      continuationPolicy: "wake_assignee", createdByAgentId: owner, addresseeAgentId: reviewer,
      requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "explicit",
      payload: { version: 1, prompt: "Review the existing work" },
      ...(status === "accepted" ? { resolvedByAgentId: reviewer, resolvedAt: new Date(), result: { version: 1, outcome: "accepted" } } : {}) });
    return { companyId, owner, reviewer, issueId, interactionId };
  }

  function transport(companyId: string, beforeInsert?: () => Promise<void>) {
    // Only the external execution boundary is controlled. Receipts and their
    // actual PostgreSQL uniqueness constraint are real, including concurrent calls.
    const wakeup = vi.fn(async (agentId: string, request: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1] = {}) => {
      await beforeInsert?.();
      await db.insert(agentWakeupRequests).values({ companyId, agentId,
        source: request.source as string, triggerDetail: request.triggerDetail as string,
        reason: request.reason as string, payload: request.payload as Record<string, unknown>,
        idempotencyKey: request.idempotencyKey as string,
        requestedByActorType: request.requestedByActorType as string,
        requestedByActorId: request.requestedByActorId as string, status: "queued" }).onConflictDoNothing();
      return null;
    });
    return { wakeup };
  }

  it("recovers committed creation after a crash before the route wake; a new service does not duplicate it", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    const restarted = interactionWakeDeliveryService(db, { heartbeat });
    expect(await restarted.hasPending()).toBe(true);
    await restarted.sweepPending();
    const [receipt] = await db.select().from(agentWakeupRequests);
    expect(receipt).toMatchObject({ agentId: s.reviewer, idempotencyKey: pendingInteractionWakeKey(s.interactionId), requestedByActorType: "agent", requestedByActorId: s.owner });
    expect(receipt.payload).toMatchObject({ issueId: s.issueId, interactionId: s.interactionId, mutation: "interaction" });
    await interactionWakeDeliveryService(db, { heartbeat }).sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(await restarted.hasPending()).toBe(false);
  });

  it("two concurrent delivery workers create one durable wake receipt", async () => {
    const s = await seed(); let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const heartbeat = transport(s.companyId, async () => { if (++arrivals === 2) release(); await barrier; });
    await Promise.all([interactionWakeDeliveryService(db, { heartbeat }).sweepPending(), interactionWakeDeliveryService(db, { heartbeat }).sweepPending()]);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("recovers a committed confirmation resolution with the real resolver and unchanged owner", async () => {
    const s = await seed("accepted"); const heartbeat = transport(s.companyId);
    await interactionWakeDeliveryService(db, { heartbeat }).sweepPending();
    const [receipt] = await db.select().from(agentWakeupRequests);
    expect(receipt).toMatchObject({ agentId: s.owner, requestedByActorType: "agent", requestedByActorId: s.reviewer, idempotencyKey: `interaction:${s.interactionId}:accepted` });
    expect(receipt.payload).toMatchObject({ interactionStatus: "accepted", mutation: "interaction" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue.assigneeAgentId).toBe(s.owner);
    expect(await interactionWakeDeliveryService(db, { heartbeat }).hasPending()).toBe(false);
  });

  it.each(["cancelled", "failed", "skipped"])("does not replay an existing %s receipt", async (status) => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.reviewer, source: "automation", status, idempotencyKey: pendingInteractionWakeKey(s.interactionId), payload: { issueId: s.issueId } });
    const service = interactionWakeDeliveryService(db, { heartbeat });
    expect(await service.hasPending()).toBe(false); await service.sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("honors the legacy pending wake key without issuing a replacement", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.reviewer, source: "automation", status: "cancelled", idempotencyKey: `interaction-pending:${s.interactionId}`, payload: { issueId: s.issueId } });
    await interactionWakeDeliveryService(db, { heartbeat }).sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("filters human-only, stale and malformed cards before the batch limit", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    const old = new Date("2020-01-01");
    await db.insert(issueThreadInteractions).values(Array.from({ length: 55 }, () => ({ id: randomUUID(), companyId: s.companyId, issueId: s.issueId, kind: "ask_user_questions", status: "pending", effectiveResolverPolicy: "human_only", requestedResolverPolicy: "human_only", addresseeAgentId: s.reviewer, createdByAgentId: s.owner, payload: { version: 1, questions: [] }, createdAt: old })));
    await db.insert(issueThreadInteractions).values({ id: randomUUID(), companyId: s.companyId, issueId: s.issueId, kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "not_creator", addresseeAgentId: s.reviewer, createdByAgentId: s.owner,
      payload: { version: 1, prompt: "Malformed historical target", target: { type: "issue_document", issueId: "malformed-legacy-id", key: "plan", revisionId: randomUUID() } }, createdAt: old });
    await interactionWakeDeliveryService(db, { heartbeat }).sweepPending(1);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(await interactionWakeDeliveryService(db, { heartbeat }).hasPending()).toBe(false);
  });

  it("keeps stale document targets out of a one-item batch while delivering the current revision", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    const documentId = randomUUID(), revisionId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId: s.companyId,
      latestBody: "Reviewed ticket breakdown", latestRevisionId: revisionId });
    await db.insert(issueDocuments).values({ companyId: s.companyId, issueId: s.issueId,
      documentId, key: "ticket-breakdown" });
    const target = { type: "issue_document" as const, issueId: s.issueId, documentId, key: "ticket-breakdown", revisionId };
    await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: "Review current tickets", target } })
      .where(eq(issueThreadInteractions.id, s.interactionId));
    await db.insert(issueThreadInteractions).values({ id: randomUUID(), companyId: s.companyId,
      issueId: s.issueId, kind: "request_confirmation", createdByAgentId: s.owner, addresseeAgentId: s.reviewer,
      effectiveResolverPolicy: "not_creator", payload: { version: 1, prompt: "Old tickets",
        target: { ...target, revisionId: randomUUID() } }, createdAt: new Date("2020-01-01") });
    const service = interactionWakeDeliveryService(db, { heartbeat });
    await service.sweepPending(1);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(heartbeat.wakeup.mock.calls[0][1]?.payload).toMatchObject({ interactionId: s.interactionId });
    expect(await service.hasPending()).toBe(false);
  });

  it("does not spin on an accept-only rejected card whose target is not a local plan", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    await db.update(issueThreadInteractions).set({ status: "rejected", resolvedByAgentId: s.reviewer,
      continuationPolicy: "wake_assignee_on_accept", payload: { version: 1, prompt: "Not a local plan",
        target: { type: "issue_document", issueId: randomUUID(), key: "plan", revisionId: randomUUID() } } })
      .where(eq(issueThreadInteractions.id, s.interactionId));
    const service = interactionWakeDeliveryService(db, { heartbeat });
    expect(await service.hasPending()).toBe(false); await service.sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("does not spend a wake while paused, then delivers after the reviewer resumes", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId); const service = interactionWakeDeliveryService(db, { heartbeat });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.reviewer));
    expect(await service.hasPending()).toBe(false);
    await service.sweepPending();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, s.reviewer));
    expect(await service.hasPending()).toBe(true);
    await service.sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not spend a wake while the company is paused, then resumes the undelivered intent", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId); const service = interactionWakeDeliveryService(db, { heartbeat });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, s.companyId));
    expect(await service.hasPending()).toBe(false); await service.sweepPending();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, s.companyId));
    expect(await service.hasPending()).toBe(true); await service.sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a terminal issue without a prior wake receipt", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId); const service = interactionWakeDeliveryService(db, { heartbeat });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.issueId));
    expect(await service.hasPending()).toBe(false); await service.sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("rechecks an unspent budget-gate diagnostic after replenishment without replaying a provider run", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId); const service = interactionWakeDeliveryService(db, { heartbeat });
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({ id: policyId, companyId: s.companyId, scopeType: "agent",
      scopeId: s.reviewer, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 10, hardStopEnabled: true });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.reviewer,
      provider: "test", model: "test", costCents: 20, occurredAt: new Date() });
    expect(await service.hasPending()).toBe(false); await service.sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    // This is a prior pre-admission diagnostic, not a cancelled/failed run.
    await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.reviewer,
      source: "automation", status: "skipped", reason: "budget.blocked", runId: null,
      idempotencyKey: pendingInteractionWakeKey(s.interactionId),
      payload: { issueId: s.issueId, executionWait: { scopeType: "agent", scopeId: s.reviewer } } });
    expect(await service.hasPending()).toBe(false);
    await db.update(budgetPolicies).set({ amount: 100 }).where(eq(budgetPolicies.id, policyId));
    expect(await service.hasPending()).toBe(true); await service.sweepPending();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    const receipts = await db.select().from(agentWakeupRequests);
    expect(receipts.filter(r => r.status === "skipped")).toHaveLength(1);
    expect(receipts.filter(r => r.status === "queued")).toHaveLength(1);
    expect(await service.hasPending()).toBe(false);
  });

  it("leaves answered question delivery to its existing outbox", async () => {
    const s = await seed(); const heartbeat = transport(s.companyId);
    await db.update(issueThreadInteractions).set({ kind: "ask_user_questions", status: "answered", resolvedByAgentId: s.reviewer }).where(eq(issueThreadInteractions.id, s.interactionId));
    await interactionWakeDeliveryService(db, { heartbeat }).sweepPending();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });
});
