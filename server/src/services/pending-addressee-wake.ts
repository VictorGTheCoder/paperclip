import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentWakeupRequests, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { evaluateIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";

/** Pending recipient authority is derived from stored state, never the reason alone.
 * Claim callers hold the issue lock and request NOWAIT to avoid inverted verdict locks.
 * A failed lock defers admission; it must never grant execution authority.
 */
export async function verifyPendingAddresseeWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  contextSnapshot: Record<string, unknown>; lock?: boolean;
}): Promise<boolean> {
  const id = input.contextSnapshot.interactionId;
  if (input.contextSnapshot.wakeReason !== "interaction_pending" ||
      typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const query = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.status, "pending"),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
  )).limit(1);
  const [interaction] = await (input.lock ? query.for("update", { noWait: true }) : query);
  if (!interaction || interaction.resolvedAt ||
      !["ask_user_questions", "request_confirmation", "request_checkbox_confirmation", "request_item_verdicts"].includes(interaction.kind)) return false;
  const payload = interaction.payload as unknown as Record<string, unknown>;
  return evaluateIssueThreadInteractionResolverAudience({
    actor: { type: "agent", agentId: input.agentId, runId: input.runId }, interaction,
    governedAction: interaction.kind === "request_confirmation" &&
      (payload?.toolAction !== undefined || payload?.secretProposal !== undefined),
  }).allowed;
}

/** Cancellation must not discard already-adopted user input. The receipt is
 * committed with cancellation, then re-enters normal current-owner admission. */
export async function preserveStaleRecipientComments(db: Db, input: {
  companyId: string; issueId: string; runId: string; commentIds: string[];
}) {
  const ids = [...new Set(input.commentIds)].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (!ids.length) return;
  const [issue] = await db.select({ assignee: issues.assigneeAgentId }).from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue?.assignee) return;
  const comments = await db.select({ id: issueComments.id, author: issueComments.authorUserId })
    .from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids), eq(issueComments.authorType, "user"),
      isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt)));
  const live = comments.filter(c => c.author);
  if (!live.length) return;
  const key = `stale-addressee-requeue:${input.runId}`;
  const [existing] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
  if (existing) return;
  await db.insert(agentWakeupRequests).values({ companyId: input.companyId, agentId: issue.assignee,
    source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
    requestedByActorType: "user", requestedByActorId: live[0].author,
    idempotencyKey: key, status: "deferred_issue_execution",
    payload: withQueuedCommentIdsInWakePayload({ issueId: input.issueId,
      _paperclipWakeContext: { issueId: input.issueId, requeuedFromRunId: input.runId } }, live.map(c => c.id)),
  });
}
