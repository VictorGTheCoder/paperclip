import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { reviewOwnerTransferRefusalCode, type IssueExecutionState } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { issueReviewOwnerTransferService } from "../services/issue-review-owner-transfer.ts";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";

// No adapter may ever execute from this suite: agents also opt out of
// on-demand wakes, so workflow hand-offs never start a real run.
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => {
  throw new Error("adapter execution is not allowed in review owner transfer tests");
}));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review owner transfer tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const BOARD_USER = "board-user";

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {} };
    },
  } as any;
}

describeEmbeddedPostgres("review owner transfer (service, REST, plugin host)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-owner-transfer-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // PATCH hand-offs record (skipped) wake requests fire-and-forget; let them land first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(companyMemberships);
    for (let attempt = 0; ; attempt += 1) {
      await db.delete(agentWakeupRequests);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt >= 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: BOARD_USER,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string, runId?: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_jwt", ...(runId ? { runId } : {}) };
  }

  /**
   * One agent action the way a real heartbeat performs it: a live run makes
   * the PATCH (adopting the checkout when needed), then the run finishes.
   * The run is never executed by an adapter.
   */
  async function patchAsAgentRun(s: { companyId: string; issueId: string }, agentId: string, body: Record<string, unknown>) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: s.companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: s.issueId },
    });
    try {
      return await patchAs(agentActor(s.companyId, agentId, runId), s.issueId, body);
    } finally {
      // Locks left pointing at the finished run are released lazily by Paperclip, as in production.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    }
  }

  async function insertCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: `${prefix}${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgent(companyId: string, name: string, status = "idle") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    return id;
  }

  async function seed(options: { maxReviewRounds?: number } = {}) {
    const companyId = await insertCompany("RO");
    const otherCompanyId = await insertCompany("OT");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER,
      status: "active",
      membershipRole: "owner",
    });
    const engineerA = await insertAgent(companyId, "Engineer A");
    const reviewerR = await insertAgent(companyId, "Reviewer R");
    const seniorB = await insertAgent(companyId, "Senior B");
    const seniorC = await insertAgent(companyId, "Senior C");
    const terminatedT = await insertAgent(companyId, "Terminated T", "terminated");
    const foreignX = await insertAgent(otherCompanyId, "Foreign X");
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerR }] }],
      maxReviewRounds: options.maxReviewRounds ?? 6,
    })!;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RO-1",
      title: "Native review owner transfer",
      status: "in_progress",
      assigneeAgentId: engineerA,
      responsibleUserId: BOARD_USER,
      createdByUserId: BOARD_USER,
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionWorkspacePreference: "reuse_existing",
    });
    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "4242",
      title: "PR #4242",
      url: "https://github.com/example/repo/pull/4242",
      status: "open",
      isPrimary: true,
    });
    return {
      companyId,
      otherCompanyId,
      issueId,
      workProductId,
      stageId: policy.stages[0]!.id!,
      engineerA,
      reviewerR,
      seniorB,
      seniorC,
      terminatedT,
      foreignX,
    };
  }

  type Seed = Awaited<ReturnType<typeof seed>>;

  async function loadIssue(issueId: string) {
    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    return { ...row, state: row.executionState as unknown as IssueExecutionState | null };
  }

  async function patchAs(actor: Express.Request["actor"], issueId: string, body: Record<string, unknown>) {
    const res = await request(createApp(actor)).patch(`/api/issues/${issueId}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res;
  }

  async function submit(s: Seed, executorAgentId: string) {
    await patchAsAgentRun(s, executorAgentId, { status: "in_review", comment: "Ready for review" });
    const issue = await loadIssue(s.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(s.reviewerR);
    return issue;
  }

  async function requestChanges(s: Seed, round: number) {
    await patchAsAgentRun(s, s.reviewerR, {
      status: "in_progress",
      comment: `Round ${round}: still needs work`,
    });
    return loadIssue(s.issueId);
  }

  async function transferViaApi(
    s: Seed,
    body: Record<string, unknown>,
    actor: Express.Request["actor"] = boardActor(s.companyId),
  ) {
    return request(createApp(actor)).post(`/api/issues/${s.issueId}/review-owner/transfer`).send(body);
  }

  async function engineerRounds(s: Seed, rounds: number) {
    for (let round = 1; round <= rounds; round += 1) {
      await submit(s, s.engineerA);
      const issue = await requestChanges(s, round);
      expect(issue.status).toBe("in_progress");
      expect(issue.assigneeAgentId).toBe(s.engineerA);
      expect(issue.state?.changesRequestedCount).toBe(round);
    }
    return loadIssue(s.issueId);
  }

  async function transferActivities(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.review_owner_transferred")));
  }

  it("proves Engineer ×3 → transfer → Senior ×3 → Human on one issue, stage and PR lineage", async () => {
    const s = await seed({ maxReviewRounds: 6 });
    const before = await engineerRounds(s, 3);
    const decisionsBefore = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, s.issueId));
    expect(decisionsBefore).toHaveLength(3);

    const res = await transferViaApi(s, {
      targetAgentId: s.seniorB,
      expectedCurrentOwnerAgentId: s.engineerA,
      reason: "Escalating repair to senior after three rounds",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "transferred",
      previousOwnerAgentId: s.engineerA,
      ownerAgentId: s.seniorB,
      stageId: s.stageId,
      changesRequestedCount: 3,
    });

    const transferred = await loadIssue(s.issueId);
    expect(transferred.assigneeAgentId).toBe(s.seniorB);
    expect(transferred.status).toBe("in_progress");
    // Everything but returnAssignee is carried over verbatim.
    expect(transferred.state).toEqual({
      ...before.state,
      returnAssignee: { type: "agent", agentId: s.seniorB, userId: null },
    });
    expect(transferred.executionPolicy).toEqual(before.executionPolicy);
    expect(transferred.executionWorkspaceId).toBe(before.executionWorkspaceId);
    expect(transferred.executionWorkspacePreference).toBe(before.executionWorkspacePreference);
    expect(transferred.executionWorkspaceSettings).toEqual(before.executionWorkspaceSettings);
    expect(transferred.projectId).toBe(before.projectId);

    for (const round of [4, 5]) {
      const pending = await submit(s, s.seniorB);
      expect(pending.state).toMatchObject({
        status: "pending",
        currentStageId: s.stageId,
        currentParticipant: { type: "agent", agentId: s.reviewerR },
        returnAssignee: { type: "agent", agentId: s.seniorB },
        changesRequestedCount: round - 1,
      });
      const repaired = await requestChanges(s, round);
      expect(repaired.status).toBe("in_progress");
      expect(repaired.assigneeAgentId).toBe(s.seniorB);
      expect(repaired.state).toMatchObject({
        status: "changes_requested",
        currentStageId: s.stageId,
        returnAssignee: { type: "agent", agentId: s.seniorB },
        changesRequestedCount: round,
      });
    }

    await submit(s, s.seniorB);
    const escalated = await requestChanges(s, 6);
    expect(escalated.status).toBe("in_review");
    expect(escalated.assigneeAgentId).toBeNull();
    expect(escalated.assigneeUserId).toBe(BOARD_USER);
    expect(escalated.state).toMatchObject({
      status: "pending",
      currentStageId: s.stageId,
      currentParticipant: { type: "user", userId: BOARD_USER },
      returnAssignee: { type: "agent", agentId: s.seniorB },
      changesRequestedCount: 6,
    });

    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, s.issueId));
    expect(decisions).toHaveLength(6);
    expect(decisions.every((decision) => decision.stageId === s.stageId && decision.outcome === "changes_requested")).toBe(true);
    expect(decisions.every((decision) => decision.actorAgentId === s.reviewerR)).toBe(true);

    // The pending human cannot be replaced by a transfer.
    const blocked = await transferViaApi(s, { targetAgentId: s.seniorC });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ code: "human_participant_pending" });
    expect((await loadIssue(s.issueId)).assigneeUserId).toBe(BOARD_USER);

    // The human's Request changes routes to the transferred owner (counter reset is native behavior).
    await patchAs(boardActor(s.companyId), s.issueId, { status: "in_progress", comment: "Human: take approach X" });
    const afterHuman = await loadIssue(s.issueId);
    expect(afterHuman.status).toBe("in_progress");
    expect(afterHuman.assigneeAgentId).toBe(s.seniorB);
    expect(afterHuman.state).toMatchObject({
      status: "changes_requested",
      returnAssignee: { type: "agent", agentId: s.seniorB },
      changesRequestedCount: 0,
    });

    // Same issue, same PR lineage throughout; exactly one transfer was recorded.
    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId));
    expect(workProducts).toEqual([expect.objectContaining({ id: s.workProductId, externalId: "4242", isPrimary: true })]);
    const activities = await transferActivities(s.issueId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      actorType: "user",
      actorId: BOARD_USER,
      details: expect.objectContaining({
        previousOwnerAgentId: s.engineerA,
        ownerAgentId: s.seniorB,
        changesRequestedCount: 3,
        reason: "Escalating repair to senior after three rounds",
      }),
    });
  });

  it("is idempotent: a repeated transfer converges without writes, activity or wakes", async () => {
    const s = await seed();
    await engineerRounds(s, 3);
    const first = await transferViaApi(s, { targetAgentId: s.seniorB, expectedCurrentOwnerAgentId: s.engineerA });
    expect(first.body.outcome).toBe("transferred");
    const afterFirst = await loadIssue(s.issueId);

    // Duplicate delivery with the same (now stale) expectation still converges.
    const second = await transferViaApi(s, { targetAgentId: s.seniorB, expectedCurrentOwnerAgentId: s.engineerA });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ outcome: "noop", ownerAgentId: s.seniorB, changesRequestedCount: 3 });
    const afterSecond = await loadIssue(s.issueId);
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(afterSecond.state).toEqual(afterFirst.state);
    expect(await transferActivities(s.issueId)).toHaveLength(1);
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.seniorB));
    expect(wakeups).toHaveLength(0);
  });

  it("allows a fresh transfer Senior B → Senior C and refuses a stale compare-and-set", async () => {
    const s = await seed();
    await engineerRounds(s, 3);
    await transferViaApi(s, { targetAgentId: s.seniorB });

    const stale = await transferViaApi(s, { targetAgentId: s.seniorC, expectedCurrentOwnerAgentId: s.engineerA });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ code: "expected_owner_mismatch", currentOwnerAgentId: s.seniorB });

    const next = await transferViaApi(s, { targetAgentId: s.seniorC, expectedCurrentOwnerAgentId: s.seniorB });
    expect(next.body).toMatchObject({ outcome: "transferred", previousOwnerAgentId: s.seniorB, ownerAgentId: s.seniorC });
    const issue = await loadIssue(s.issueId);
    expect(issue.assigneeAgentId).toBe(s.seniorC);
    expect(issue.state?.returnAssignee).toMatchObject({ agentId: s.seniorC });
    expect(issue.state?.changesRequestedCount).toBe(3);
  });

  it("repairs a plain reassignment that left returnAssignee on the original engineer", async () => {
    const s = await seed();
    await engineerRounds(s, 3);
    await patchAs(boardActor(s.companyId), s.issueId, { assigneeAgentId: s.seniorB });
    const drifted = await loadIssue(s.issueId);
    expect(drifted.state?.returnAssignee).toMatchObject({ agentId: s.engineerA });

    const res = await transferViaApi(s, { targetAgentId: s.seniorB });
    expect(res.body).toMatchObject({ outcome: "transferred", previousOwnerAgentId: s.engineerA });
    await submit(s, s.seniorB);
    const repaired = await requestChanges(s, 4);
    expect(repaired.assigneeAgentId).toBe(s.seniorB);
  });

  it("serializes concurrent transfers without corrupting the execution state", async () => {
    const s = await seed();
    const before = await engineerRounds(s, 3);
    const svc = issueReviewOwnerTransferService(db);
    const actor = { actorType: "user" as const, actorId: BOARD_USER };
    const results = await Promise.allSettled([
      svc.transfer({ companyId: s.companyId, issueId: s.issueId, targetAgentId: s.seniorB, expectedCurrentOwnerAgentId: s.engineerA, actor }),
      svc.transfer({ companyId: s.companyId, issueId: s.issueId, targetAgentId: s.seniorC, expectedCurrentOwnerAgentId: s.engineerA, actor }),
      svc.transfer({ companyId: s.companyId, issueId: s.issueId, targetAgentId: s.seniorB, expectedCurrentOwnerAgentId: s.engineerA, actor }),
    ]);
    const issue = await loadIssue(s.issueId);
    const owner = issue.state?.returnAssignee?.agentId;
    expect([s.seniorB, s.seniorC]).toContain(owner);
    expect(issue.assigneeAgentId).toBe(owner);
    expect(issue.state).toEqual({ ...before.state, returnAssignee: { type: "agent", agentId: owner, userId: null } });
    // Exactly one real transition; the others converged (same target) or lost the compare-and-set.
    expect(await transferActivities(s.issueId)).toHaveLength(1);
    for (const result of results) {
      if (result.status === "fulfilled") {
        expect(result.value.summary.ownerAgentId).toBe(owner);
      } else {
        expect(reviewOwnerTransferRefusalCode(result.reason)).toBe("expected_owner_mismatch");
      }
    }
  });

  describe("fails closed", () => {
    async function expectRefused(s: Seed, body: Record<string, unknown>, status: number, code: string | null) {
      const before = await loadIssue(s.issueId);
      const res = await transferViaApi(s, body);
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.details?.code ?? null).toBe(code);
      const after = await loadIssue(s.issueId);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.state).toEqual(before.state);
      expect(after.assigneeAgentId).toBe(before.assigneeAgentId);
      expect(await transferActivities(s.issueId)).toHaveLength(0);
    }

    it("refuses unknown, foreign-company and terminated targets at the REST tasks:assign gate", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      for (const targetAgentId of [randomUUID(), s.foreignX, s.terminatedT]) {
        // The native assignment authorization rejects these before the service runs.
        await expectRefused(s, { targetAgentId }, 403, null);
      }
    });

    it("refuses unknown, foreign-company and terminated targets in the service with stable codes", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const svc = issueReviewOwnerTransferService(db);
      const attempt = (targetAgentId: string) =>
        svc.transfer({
          companyId: s.companyId,
          issueId: s.issueId,
          targetAgentId,
          actor: { actorType: "user", actorId: BOARD_USER },
        }).catch((error: unknown) => error);
      expect(reviewOwnerTransferRefusalCode(await attempt(randomUUID()))).toBe("target_agent_not_found");
      expect(reviewOwnerTransferRefusalCode(await attempt(s.foreignX))).toBe("target_agent_not_found");
      expect(reviewOwnerTransferRefusalCode(await attempt(s.terminatedT))).toBe("target_agent_not_assignable");
      const issue = await loadIssue(s.issueId);
      expect(issue.assigneeAgentId).toBe(s.engineerA);
      expect(issue.state?.returnAssignee).toMatchObject({ agentId: s.engineerA });
      expect(await transferActivities(s.issueId)).toHaveLength(0);
    });

    it("refuses a user id as the target", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const res = await transferViaApi(s, { targetAgentId: BOARD_USER });
      expect(res.status).toBe(400);
    });

    it("refuses an issue without a native review workflow", async () => {
      const s = await seed();
      await db.update(issues).set({ executionPolicy: null, executionState: null }).where(eq(issues.id, s.issueId));
      await expectRefused(s, { targetAgentId: s.seniorB }, 422, "no_native_review_workflow");
    });

    it("refuses a terminal issue", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, s.issueId));
      await expectRefused(s, { targetAgentId: s.seniorB }, 409, "issue_terminal");
    });

    it("refuses while the agent review decision is pending", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await submit(s, s.engineerA);
      await expectRefused(s, { targetAgentId: s.seniorB }, 409, "review_decision_pending");
    });

    it("refuses the reviewer as the new owner", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await expectRefused(s, { targetAgentId: s.reviewerR }, 422, "target_is_reviewer");
    });

    it("refuses while the previous owner is still running on the issue", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: s.companyId,
        agentId: s.engineerA,
        status: "running",
        contextSnapshot: { issueId: s.issueId },
      });
      await expectRefused(s, { targetAgentId: s.seniorB }, 409, "owner_run_active");
    });

    it("refuses while the previous owner has a scheduled retry", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await db.insert(heartbeatRuns).values({
        companyId: s.companyId,
        agentId: s.engineerA,
        status: "scheduled_retry",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: new Date(Date.now() + 60_000),
        contextSnapshot: { issueId: s.issueId },
      });
      await expectRefused(s, { targetAgentId: s.seniorB }, 409, "scheduled_retry_pending");
    });

    it("allows a queued old-owner run, which native stale-queue invalidation cancels", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await db.insert(heartbeatRuns).values({
        companyId: s.companyId,
        agentId: s.engineerA,
        status: "queued",
        contextSnapshot: { issueId: s.issueId },
      });
      const res = await transferViaApi(s, { targetAgentId: s.seniorB });
      expect(res.body.outcome).toBe("transferred");
    });

    it("refuses while an active recovery action owns the issue", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      await db.insert(issueRecoveryActions).values({
        companyId: s.companyId,
        sourceIssueId: s.issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        cause: "test",
        fingerprint: `test:${s.issueId}`,
        nextAction: "Investigate",
      });
      await expectRefused(s, { targetAgentId: s.seniorB }, 409, "active_recovery_action");
    });
  });

  describe("authorization", () => {
    it("refuses agent callers on the REST route (board only)", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const res = await transferViaApi(s, { targetAgentId: s.seniorB }, agentActor(s.companyId, s.engineerA));
      expect(res.status).toBe(403);
      expect((await loadIssue(s.issueId)).assigneeAgentId).toBe(s.engineerA);
    });

    it("refuses board users without access to the issue's company", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const res = await transferViaApi(s, { targetAgentId: s.seniorB }, boardActor(s.otherCompanyId));
      // Issues outside the actor's companies are reported as missing.
      expect(res.status).toBe(404);
      expect((await loadIssue(s.issueId)).assigneeAgentId).toBe(s.engineerA);
    });
  });

  describe("plugin host", () => {
    function pluginHandlers(capabilities: string[], scopedCompanyId: string) {
      const services = buildHostServices(db, "plugin-record-id", "paperclip.tft-observer", createEventBusStub());
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.tft-observer",
        capabilities: capabilities as any,
        services,
      });
      const context = { invocationScope: { companyId: scopedCompanyId } };
      return {
        transferReviewOwner: (params: Parameters<(typeof handlers)["issues.review.transferOwner"]>[0]) =>
          handlers["issues.review.transferOwner"](params, context),
      };
    }

    it("transfers through issues.review.transferOwner with the dedicated capability and stays a no-op on redelivery", async () => {
      const s = await seed();
      await engineerRounds(s, 3);
      const handlers = pluginHandlers(["issues.review.transfer_owner"], s.companyId);
      const params = {
        issueId: s.issueId,
        companyId: s.companyId,
        targetAgentId: s.seniorB,
        expectedCurrentOwnerAgentId: s.engineerA,
        reason: "observer: 3 rounds exhausted",
      };
      await expect(handlers.transferReviewOwner(params)).resolves.toMatchObject({
        outcome: "transferred",
        previousOwnerAgentId: s.engineerA,
        ownerAgentId: s.seniorB,
        changesRequestedCount: 3,
        issue: expect.objectContaining({ id: s.issueId, assigneeAgentId: s.seniorB }),
      });
      await expect(handlers.transferReviewOwner(params)).resolves.toMatchObject({ outcome: "noop" });

      const activities = await transferActivities(s.issueId);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        actorType: "plugin",
        actorId: "plugin-record-id",
        details: expect.objectContaining({ sourcePluginKey: "paperclip.tft-observer", ownerAgentId: s.seniorB }),
      });

      // The transfer re-routes the native hand-back for the next round.
      await submit(s, s.seniorB);
      const round4 = await requestChanges(s, 4);
      expect(round4.assigneeAgentId).toBe(s.seniorB);
      expect(round4.state?.changesRequestedCount).toBe(4);
    });

    it("denies plugins that only hold issues.update", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const handlers = pluginHandlers(["issues.read", "issues.update"], s.companyId);
      await expect(
        handlers.transferReviewOwner({ issueId: s.issueId, companyId: s.companyId, targetAgentId: s.seniorB }),
      ).rejects.toThrow(/issues\.review\.transfer_owner/);
      expect((await loadIssue(s.issueId)).assigneeAgentId).toBe(s.engineerA);
    });

    it("surfaces a stable refusal code to the plugin when a human holds the review", async () => {
      const s = await seed({ maxReviewRounds: 1 });
      await submit(s, s.engineerA);
      await requestChanges(s, 1);
      expect((await loadIssue(s.issueId)).assigneeUserId).toBe(BOARD_USER);
      const handlers = pluginHandlers(["issues.review.transfer_owner"], s.companyId);
      const error = await handlers.transferReviewOwner({
        issueId: s.issueId,
        companyId: s.companyId,
        targetAgentId: s.seniorB,
      }).catch((err: unknown) => err);
      expect(reviewOwnerTransferRefusalCode(error)).toBe("human_participant_pending");
      expect((await loadIssue(s.issueId)).assigneeUserId).toBe(BOARD_USER);
    });

    it("refuses issues of another company and cross-company invocation scopes", async () => {
      const s = await seed();
      await engineerRounds(s, 1);
      const foreignScoped = pluginHandlers(["issues.review.transfer_owner"], s.otherCompanyId);
      await expect(
        foreignScoped.transferReviewOwner({ issueId: s.issueId, companyId: s.otherCompanyId, targetAgentId: s.foreignX }),
      ).rejects.toThrow(/not found/i);
      await expect(
        foreignScoped.transferReviewOwner({ issueId: s.issueId, companyId: s.companyId, targetAgentId: s.seniorB }),
      ).rejects.toThrow(/scoped to company/);
      expect((await loadIssue(s.issueId)).assigneeAgentId).toBe(s.engineerA);
    });
  });
});
