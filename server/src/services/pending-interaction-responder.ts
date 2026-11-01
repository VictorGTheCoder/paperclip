import { assertIssueReviewVerdictActorAllowed, isIssueReviewVerdictInteraction } from "./issue-review-policy.js";
import { agents, documents, issueDocuments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { authorizationService } from "./authorization.js";
import { canonicalizeStoredResolverPolicy, evaluateIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";

export type PendingInteractionResponder = {
  purpose: "interaction_responder";
  interactionId: string;
  interactionUpdatedAt: string;
};

/** A hint selects a card; only current persisted authority permits responding. */
export function pendingInteractionId(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const value = context as Record<string, unknown>;
  const marker = value.interactionResponder as Partial<PendingInteractionResponder> | undefined;
  const id = marker?.purpose === "interaction_responder" ? marker.interactionId : value.interactionId;
  return ((value.wakeReason === "interaction_pending" && value.source === "issue.interaction.created") ||
    (value.wakeReason === "interaction_response_requested" && value.source === "agent.wakeup.interaction_requested") ||
    marker?.purpose === "interaction_responder") &&
    typeof id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export async function readPendingInteractionResponder(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  runId?: string | null;
  responsibleUserId?: string | null;
  contextSnapshot: unknown;
  /** Use only in a transaction that already locks the issue before its card. */
  lockForUpdate?: boolean;
  /** Native responder reads may settle after their own answer; dispatch must omit this. */
  allowResolvedByRunId?: string;
  /** Initial admission preflight only: no run exists yet; dispatch always rechecks real run attribution. */
  forAdmission?: boolean;
}): Promise<PendingInteractionResponder | null> {
  const id = pendingInteractionId(input.contextSnapshot);
  if (!id) return null;
  const issue = await db.select().from(issues).where(and(eq(issues.id, input.issueId),
    eq(issues.companyId, input.companyId))).then(rows => rows[0]);
  if (!issue) return null;
  const query = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId)));
  const card = await (input.lockForUpdate ? query.for("update") : query).then(rows => rows[0]);
  if (!card || card.companyId !== input.companyId || card.issueId !== input.issueId ||
      card.addresseeAgentId !== input.agentId || card.addresseeUserId) return null;
  const resolvedByThisRun = input.allowResolvedByRunId === input.runId && Boolean(input.runId) &&
    card.resolvedByRunId === input.runId && card.resolvedByAgentId === input.agentId &&
    ["accepted", "answered", "rejected"].includes(card.status);
  if (card.status !== "pending" && !resolvedByThisRun) return null;
  if (!resolvedByThisRun && ["done", "cancelled"].includes(issue.status)) return null;
  if (!["request_confirmation", "ask_user_questions"].includes(card.kind)) return null;
  const marker = (input.contextSnapshot as Record<string, unknown>)?.interactionResponder as Partial<PendingInteractionResponder> | undefined;
  if (!resolvedByThisRun && marker?.interactionUpdatedAt && marker.interactionUpdatedAt !== card.updatedAt.toISOString()) return null;
  const payload = card.payload as unknown as Record<string, unknown>;
  // Completion-review and privileged confirmations retain their existing admission owners.
  if (payload.toolAction || payload.secretProposal) return null;
  const target = payload.target as { type?: string; issueId?: string; documentId?: string; key?: string; revisionId?: string; revisionNumber?: number } | undefined;
  if (target?.type === "custom" && target.key === "native_completion_review") return null;
  if (input.forAdmission) {
    const policy = canonicalizeStoredResolverPolicy(card.effectiveResolverPolicy, card.resolverPolicyProvenance);
    // Initial admission creates a fresh run, never reuses sourceRunId. Its
    // eventual attributed run must still pass the full canonical evaluator.
    if (policy === "human_only" || (policy === "not_creator" && card.createdByAgentId === input.agentId)) return null;
  } else if (!evaluateIssueThreadInteractionResolverAudience({
    actor: { type: "agent", agentId: input.agentId, runId: input.runId }, interaction: card,
  }).allowed) return null;
  if (!resolvedByThisRun && card.kind === "request_confirmation" && issue.status === "in_review" && issue.reviewPolicy && issue.reviewPolicy !== "anyone" &&
      await isIssueReviewVerdictInteraction(db, { issue, interaction: card })) {
    try { await assertIssueReviewVerdictActorAllowed(db, { issue, actor: { type: "agent", id: input.agentId } }); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 403) return null;
      throw error;
    }
  }
  if (!resolvedByThisRun && target?.type === "issue_document") {
    if (target.issueId && target.issueId !== input.issueId) {
      const targetAccess = await authorizationService(db).decide({
        actor: { type: "agent", source: input.forAdmission ? "agent_key" : "agent_jwt", companyId: input.companyId, agentId: input.agentId,
          runId: input.runId, onBehalfOfUserId: input.responsibleUserId },
        action: "issue:read", resource: { type: "issue", companyId: input.companyId, issueId: target.issueId },
      });
      if (!targetAccess.allowed) return null;
    }
    const targetQuery = db.select({ documentId: documents.id, revisionId: documents.latestRevisionId, revisionNumber: documents.latestRevisionNumber })
      .from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(documents.companyId, input.companyId), eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, target.issueId ?? input.issueId), eq(issueDocuments.key, target.key ?? "")));
    const current = await (input.lockForUpdate ? targetQuery.for("update", { of: documents }) : targetQuery).then(rows => rows[0]);
    if (!current || (target.documentId !== undefined && target.documentId !== current.documentId) || current.revisionId !== target.revisionId ||
        (target.revisionNumber !== undefined && target.revisionNumber !== current.revisionNumber)) return null;
  }
  const agent = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).then(rows => rows[0]);
  if (!agent || !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return null;
  const access = await authorizationService(db).decide({
    actor: { type: "agent", source: input.forAdmission ? "agent_key" : "agent_jwt", companyId: input.companyId, agentId: input.agentId,
      runId: input.runId, onBehalfOfUserId: input.responsibleUserId },
    action: "issue:read", resource: { type: "issue", companyId: input.companyId, issueId: issue.id,
      projectId: issue.projectId, parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId, status: issue.status },
  });
  if (!access.allowed) return null;
  return { purpose: "interaction_responder", interactionId: card.id, interactionUpdatedAt: card.updatedAt.toISOString() };
}
