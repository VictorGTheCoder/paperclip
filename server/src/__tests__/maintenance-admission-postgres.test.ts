import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { maintenancePolicyFixture } from "./maintenance-policy-fixture.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
const execute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "Maintenance fixture", provider: "test", model: "test" })));
vi.mock("../adapters/index.js", async () => ({ ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"), getServerAdapter: () => ({ execute, supportsLocalAgentJwt: false }) }));
describe("maintenance admission at real PostgreSQL execution boundaries", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let policy: ReturnType<typeof maintenancePolicyFixture> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("maintenance-admission-"); db = createDb(temporary.connectionString); }, 60_000);
  afterEach(async () => {
    await heartbeat?.drainActiveRunExecutions();
    policy?.cleanup(); policy = undefined; execute.mockClear();
    await db.execute(sql`truncate table companies cascade`);
  });
  afterAll(async () => temporary?.cleanup());
  async function seed() {
    execute.mockImplementation(async (context: { runId: string }) => {
      const source = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId)))[0];
      // This trivial fixture really finishes its work. An unfinished task can
      // legitimately request another native recovery run; that is not a replay.
      if (source?.contextSnapshot?.issueId) await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(source.contextSnapshot.issueId)));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Maintenance fixture completed", provider: "test", model: "test" };
    });
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Maintenance fixture", issuePrefix: "MA", defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Victor", status: "active", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "425 fixture", status: "in_review", assigneeAgentId: agentId });
    policy = maintenancePolicyFixture({ companyId, issueId, agentIds: [agentId] });
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, ...policy.env } });
    return { companyId, agentId, issueId };
  }
  async function queued(f: { companyId: string; agentId: string; issueId: string }, comments = false) {
    const id = randomUUID(), wakeId = randomUUID(), commentId = randomUUID();
    if (comments) await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "responsible-user", body: "A durable question" });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId, runId: id, source: "automation", status: "queued", payload: comments ? withQueuedCommentIdsInWakePayload({ issueId: f.issueId }, [commentId]) : { issueId: f.issueId } });
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, status: "queued", invocationSource: "automation", triggerDetail: "system", wakeupRequestId: wakeId,
      contextSnapshot: { issueId: f.issueId, wakeReason: comments ? "issue_commented" : "issue_assigned", ...(comments ? { wakeCommentIds: [commentId] } : {}) } });
    return { id, wakeId, commentId };
  }
  async function receipt(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function run(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]; }
  it.each([false, true])("holds ordinary/comment claims unchanged, releases without loss or duplicates; comments=%s", async (comments) => {
    const f = await seed(), q = await queued(f, comments);
    policy!.write({ mode: "hold" }); const before = await receipt(q.wakeId);
    await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]); await heartbeat.drainActiveRunExecutions();
    expect((await run(q.id)).status).toBe("queued"); expect(await receipt(q.wakeId)).toEqual(before); expect(execute).not.toHaveBeenCalled();
    policy!.write({}); await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]); await heartbeat.drainActiveRunExecutions();
    expect((await run(q.id)).status).toBe("succeeded"); expect(execute).toHaveBeenCalledTimes(1);
    await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); expect(execute).toHaveBeenCalledTimes(1);
  }, 30_000);
  it.each([false, true])("closing after claim restores run, wake and comments atomically; comments=%s", async (comments) => {
    const f = await seed(), q = await queued(f, comments);
    const unsub = subscribeCompanyLiveEvents(f.companyId, event => {
      const body = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && body.runId === q.id && body.status === "running") policy!.write({ mode: "hold" });
    });
    try { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); } finally { unsub(); }
    expect((await run(q.id)).status).toBe("queued"); expect((await receipt(q.wakeId)).status).toBe("queued"); expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    if (comments) expect((await receipt(q.wakeId)).payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds: [q.commentId] });
  }, 30_000);
  it("preserves all three unrelated deferred Victor receipts, comments and tasks across sweeps and stale boot", async () => {
    const f = await seed(); const ids = ["9db7bd42-e2ee-45b2-8e1a-a3ad648269ec", "d5706cd6-0b22-479e-aaf8-9576bd2c3e5f", "9dac9819-d761-4706-965a-6229b5cd3730"];
    const other = [randomUUID(), randomUUID()];
    for (const issueId of other) await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Unrelated preserved work", status: "in_progress", assigneeAgentId: f.agentId });
    for (let i = 0; i < 3; i++) {
      const issueId = other[i === 2 ? 1 : 0], commentId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Unrelated durable comment" });
      await db.insert(agentWakeupRequests).values({ id: ids[i], companyId: f.companyId, agentId: f.agentId, source: "on_demand", status: "deferred_issue_execution", payload: withQueuedCommentIdsInWakePayload({ issueId }, [commentId]) });
    }
    const before = await db.select().from(agentWakeupRequests), tasks = await db.select().from(issues), comments = await db.select().from(issueComments);
    await heartbeat.resumeQueuedRuns(); policy!.write({ bootId: "old-process" });
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, ...policy!.env } }); await heartbeat.resumeQueuedRuns();
    expect(await db.select().from(agentWakeupRequests)).toEqual(before); expect(await db.select().from(issues)).toEqual(tasks); expect(await db.select().from(issueComments)).toEqual(comments);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0); expect(execute).not.toHaveBeenCalled();
  });
  it.each([false, true])("cancellation wins before actual claim and remains cancelled after release; comments=%s", async (comments) => {
    const f = await seed(), q = await queued(f, comments);
    let reached!: () => void, proceed!: () => void;
    const entered = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { proceed = r; });
    let first = true;
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, ...policy!.env }, beforeChatControlRecoveryCheck: async ({ stage }) => {
      if (stage === "claim" && first) { first = false; reached(); await gate; }
    } });
    const claiming = heartbeat.resumeQueuedRuns();
    await entered;
    const cancelling = heartbeat.cancelRun(q.id, "Authorized test cancellation", { suppressImmediateRecovery: true });
    try {
      const deadline = Date.now() + 5000;
      while ((await run(q.id)).status !== "cancelled" && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect((await run(q.id)).status).toBe("cancelled");
    } finally { proceed(); }
    await Promise.all([claiming, cancelling]); await heartbeat.drainActiveRunExecutions();
    expect((await run(q.id)).status).toBe("cancelled"); expect(execute).not.toHaveBeenCalled();
    policy!.write({ mode: "released" }); await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
    expect((await run(q.id)).status).toBe("cancelled"); expect(execute).not.toHaveBeenCalled();
  }, 30_000);
  it("holds native same-run and restart claims without altering their durable coordinator, then normal recovery may claim", async () => {
    const f = await seed(), id = randomUUID();
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agentId));
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native", nativeIssueId: f.issueId,
      contextSnapshot: { issueId: f.issueId }, runnerProfileJson: { nativeExecutionInput: { schema: "fixture" }, sessionCheckpoint: { providerSessionId: "fixture" } } });
    await db.insert(nativeRunFinalizations).values({ runId: id, companyId: f.companyId, issueId: f.issueId, phase: "retryable_failure", nextAttemptAt: new Date(0) });
    policy!.write({ mode: "hold" }); const before = await run(id), coordinator = await db.select().from(nativeRunFinalizations);
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "fixture", maintenanceEnv: policy!.env })).toHaveLength(0);
    const restart = await claimNativeRestartRecoveries({ db, restartKind: "hard", maintenanceEnv: policy!.env });
    expect(restart).toEqual([{ kind: "blocked", runId: id, reason: "maintenance_hold" }]);
    expect(await run(id)).toEqual(before); expect(await db.select().from(nativeRunFinalizations)).toEqual(coordinator);
    policy!.write({});
    const claims = await Promise.all([claimNativeSessionResumptions({ db, runnerInstanceId: "one", maintenanceEnv: policy!.env }), claimNativeSessionResumptions({ db, runnerInstanceId: "two", maintenanceEnv: policy!.env })]);
    expect(claims.flat()).toHaveLength(1); expect((await run(id)).status).toBe("running"); expect(execute).not.toHaveBeenCalled();
  }, 30_000);
});
