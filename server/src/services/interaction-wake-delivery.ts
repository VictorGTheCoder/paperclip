import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { isAgentInvokable } from "@paperclipai/shared";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, issueThreadInteractions } from "@paperclipai/db";
import { budgetService } from "./budgets.js";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";
import { queueResolvedInteractionContinuationWakeup } from "./issue-interaction-continuation.js";

type Heartbeat = {
  wakeup(agentId: string, options?: WakeupOptions): Promise<unknown>;
};

export function pendingInteractionWakeKey(interactionId: string) {
  // This prefix uses the existing database uniqueness fence for interaction wakes.
  return `interaction:${interactionId}:pending`;
}

/**
 * The interaction row is the durable intent. Queued, coalesced, run-associated,
 * failed and cancelled receipts suppress automatic replay; unknown skipped
 * receipts also stay suppressed. A known skipped executionWait diagnostic with
 * no run is not a provider attempt. Only current canonical invokability and
 * budget checks can admit its first wake, under the same uniqueness fence.
 *
 * Each query starts from one company's open issues and uses the existing
 * company/status and company/issue/status indexes. Receipt probes additionally
 * constrain payload.issueId to use the existing company/payload-issue index.
 * SQL filters ineligible cards before LIMIT, so an old human-only or stale card
 * cannot permanently hide newer work behind a fixed first page.
 */
export function interactionWakeDeliveryService(db: Db, options: { heartbeat: Heartbeat }) {
  let nextCompany = 0;
  const budgets = budgetService(db);

  async function candidates(companyId: string, limit: number, interactionId?: string) {
    const companyAgents = await db.select({ id: agents.id, companyId: agents.companyId,
      name: agents.name, status: agents.status, reportsTo: agents.reportsTo, runtimeConfig: agents.runtimeConfig })
      .from(agents).where(eq(agents.companyId, companyId));
    const invokable = companyAgents.filter(agent => isAgentInvokable({ agent, agents: companyAgents }) &&
      isHeartbeatWakeOnDemandEnabled(agent)).map(agent => agent.id);
    if (!invokable.length) return [];
    const i = issueThreadInteractions;
    const pendingAudience = sql`(
      ${i.status} = 'pending'
      AND ${i.addresseeAgentId} IS NOT NULL AND ${i.addresseeUserId} IS NULL
      AND (${i.createdByAgentId} IS NOT NULL OR ${i.createdByUserId} IS NOT NULL)
      AND ${i.effectiveResolverPolicy} IN ('anyone', 'not_creator', 'board_or_agents')
      AND (${i.effectiveResolverPolicy} = 'anyone' OR ${i.createdByAgentId} IS DISTINCT FROM ${i.addresseeAgentId})
      AND ${i.kind} IN ('ask_user_questions', 'request_confirmation')
      AND NOT (${i.payload} ? 'toolAction') AND NOT (${i.payload} ? 'secretProposal')
      AND (
        ${i.payload}->'target'->>'type' IS DISTINCT FROM 'issue_document'
        OR EXISTS (
          SELECT 1 FROM issue_documents link JOIN documents document ON document.id = link.document_id
          WHERE link.company_id = ${i.companyId} AND document.company_id = ${i.companyId}
            AND link.issue_id = CASE
              WHEN ${i.payload}->'target'->>'issueId' IS NULL THEN ${i.issueId}
              WHEN ${i.payload}->'target'->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (${i.payload}->'target'->>'issueId')::uuid
              ELSE NULL END
            AND link.key = ${i.payload}->'target'->>'key'
            AND document.latest_revision_id::text = ${i.payload}->'target'->>'revisionId'
            AND (${i.payload}->'target'->>'documentId' IS NULL OR document.id::text = ${i.payload}->'target'->>'documentId')
        )
      )
    )`;
    // Answered questions already have their own transactional delivery outbox.
    // Governed tool/secret effects and custom completion-review targets retain
    // their existing owners; this backstop does not infer their side effects.
    const resolvedContinuation = sql`(
      ${i.status} IN ('accepted', 'rejected')
      AND ${i.kind} IN ('request_confirmation', 'request_checkbox_confirmation')
      AND (${i.resolvedByAgentId} IS NOT NULL OR ${i.resolvedByUserId} IS NOT NULL)
      AND NOT (${i.payload} ? 'toolAction') AND NOT (${i.payload} ? 'secretProposal')
      AND ${i.payload}->'target'->>'type' IS DISTINCT FROM 'custom'
      AND (
        ${i.continuationPolicy} = 'wake_assignee'
        OR (${i.continuationPolicy} = 'wake_assignee_on_accept' AND ${i.status} = 'accepted')
        OR (${i.status} = 'rejected' AND ${i.kind} = 'request_confirmation'
          AND ${i.payload}->'target'->>'type' = 'issue_document'
          AND ${i.payload}->'target'->>'key' = 'plan'
          AND (${i.payload}->'target'->>'issueId' IS NULL OR ${i.payload}->'target'->>'issueId' = ${i.issueId}::text))
      )
    )`;
    const noReceipt = sql`NOT EXISTS (
      SELECT 1 FROM agent_wakeup_requests wake
      WHERE wake.company_id = ${i.companyId}
        AND wake.payload->>'issueId' = ${i.issueId}::text
        AND NOT COALESCE((wake.status = 'skipped' AND wake.run_id IS NULL
          AND wake.reason IN ('budget.blocked', 'agent.not_invokable', 'heartbeat.wakeOnDemand.disabled')
          AND jsonb_typeof(wake.payload->'executionWait') = 'object'), false)
        AND (wake.idempotency_key = 'interaction:' || ${i.id}::text || ':' ||
          CASE WHEN ${i.status} = 'pending' THEN 'pending' ELSE ${i.status} END
          OR (${i.status} = 'pending' AND wake.idempotency_key = 'interaction-pending:' || ${i.id}::text))
    )`;
    const blockedAgents = new Set<string>();
    const blockedProjects = new Set<string>();
    const selected: string[] = [];
    const budgetChecks = new Map<string, Awaited<ReturnType<typeof budgets.getInvocationBlock>>>();
    const query = () => db.select({ interaction: i, issue: {
      id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
      status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    } }).from(issues)
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .innerJoin(i, and(eq(i.companyId, issues.companyId), eq(i.issueId, issues.id)))
      .innerJoin(agents, and(eq(agents.companyId, i.companyId),
        eq(agents.id, sql`CASE WHEN ${i.status} = 'pending' THEN ${i.addresseeAgentId} ELSE ${issues.assigneeAgentId} END`)))
      .where(and(eq(issues.companyId, companyId),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        inArray(agents.id, invokable),
        ...(blockedAgents.size ? [notInArray(agents.id, [...blockedAgents])] : []),
        ...(blockedProjects.size ? [sql`(${issues.projectId} IS NULL OR ${notInArray(issues.projectId, [...blockedProjects])})`] : []),
        ...(selected.length ? [notInArray(i.id, selected)] : []),
        sql`(${pendingAudience} OR ${resolvedContinuation})`, noReceipt,
        ...(interactionId ? [eq(i.id, interactionId)] : [])))
      .orderBy(asc(i.createdAt), asc(i.id)).limit(limit - selected.length);
    const result: Awaited<ReturnType<typeof query>> = [];
    // Budget gates are company/agent/project scoped. Exclude an entire blocked
    // scope before the next LIMIT, rather than allowing its oldest cards to
    // starve other projects/reviewers. Each distinct scope is checked once in
    // this bounded delivery pass; normal admission rechecks before execution.
    for (;;) {
      const rows = await query();
      if (!rows.length) return result;
      for (const row of rows) {
        const agentId = row.interaction.status === "pending" ? row.interaction.addresseeAgentId! : row.issue.assigneeAgentId!;
        const key = `${agentId}:${row.issue.projectId ?? ""}`;
        if (!budgetChecks.has(key)) budgetChecks.set(key, await budgets.getInvocationBlock(companyId, agentId,
          { issueId: row.issue.id, projectId: row.issue.projectId }));
        const blocked = budgetChecks.get(key);
        if (blocked?.scopeType === "company") return result;
        if (blocked?.scopeType === "agent") { blockedAgents.add(agentId); continue; }
        if (blocked?.scopeType === "project") { blockedProjects.add(blocked.scopeId); continue; }
        selected.push(row.interaction.id);
        result.push(row);
        if (result.length >= limit) return result;
      }
    }
  }

  async function deliver(row: Awaited<ReturnType<typeof candidates>>[number]) {
    const { interaction: i, issue } = row;
    if (i.status === "pending") {
      if (!i.addresseeAgentId || !issueThreadInteractionAttentionAgentAllowed({ agentId: i.addresseeAgentId, interaction: i })) return;
      const actor = i.createdByAgentId
        ? { requestedByActorType: "agent" as const, requestedByActorId: i.createdByAgentId }
        : i.createdByUserId ? { requestedByActorType: "user" as const, requestedByActorId: i.createdByUserId } : {};
      await options.heartbeat.wakeup(i.addresseeAgentId, {
        source: "automation", triggerDetail: "system", reason: "interaction_pending",
        payload: { issueId: issue.id, interactionId: i.id, interactionKind: i.kind,
          sourceCommentId: i.sourceCommentId, sourceRunId: i.sourceRunId, mutation: "interaction" },
        idempotencyKey: pendingInteractionWakeKey(i.id), ...actor,
        contextSnapshot: { issueId: issue.id, taskId: issue.id, interactionId: i.id, interactionKind: i.kind,
          sourceCommentId: i.sourceCommentId, sourceRunId: i.sourceRunId,
          wakeReason: "interaction_pending", source: "issue.interaction.created" },
      });
      return;
    }
    const actor = i.resolvedByAgentId
      ? { actorType: "agent" as const, actorId: i.resolvedByAgentId }
      : i.resolvedByUserId ? { actorType: "user" as const, actorId: i.resolvedByUserId } : null;
    if (!actor) return;
    const target = (i.payload as { target?: { type?: string; key?: string } }).target;
    const freshPlan = i.kind === "request_confirmation" && i.status === "accepted" && target?.type === "issue_document" && target.key === "plan";
    await queueResolvedInteractionContinuationWakeup({ db, heartbeat: options.heartbeat,
      issue, interaction: i, actor, source: `issue.interaction.${i.status === "accepted" ? "accept" : "reject"}`,
      forceFreshSession: freshPlan, workspaceRefreshReason: freshPlan ? "accepted_plan_confirmation" : null });
  }

  async function deliverPending(interactionId: string) {
    const [interaction] = await db.select({ companyId: issueThreadInteractions.companyId })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)).limit(1);
    if (!interaction) return;
    const [row] = await candidates(interaction.companyId, 1, interactionId);
    if (row?.interaction.status === "pending") await deliver(row);
  }

  async function sweepPending(limit = 50) {
    const companyRows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active")).orderBy(asc(companies.id));
    if (!companyRows.length) return;
    let remaining = Math.max(1, Math.min(limit, 100));
    const start = nextCompany % companyRows.length;
    for (let offset = 0; offset < companyRows.length && remaining > 0; offset++) {
      const position = (start + offset) % companyRows.length;
      const rows = await candidates(companyRows[position].id, remaining);
      nextCompany = position + 1;
      for (const row of rows) {
        remaining--;
        try { await deliver(row); }
        catch (error) { logger.warn({ error, interactionId: row.interaction.id }, "interaction wake delivery deferred"); }
      }
    }
  }

  async function hasPending() {
    const companyRows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
    for (const company of companyRows) if ((await candidates(company.id, 1)).length) return true;
    return false;
  }
  return { deliverPending, sweepPending, hasPending };
}
