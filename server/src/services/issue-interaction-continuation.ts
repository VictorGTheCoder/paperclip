import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatPublications } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "./recovery/review-path-recovery.js";
import { issueService } from "./issues.js";
import type { WakeupOptions } from "./heartbeat.js";

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isClosedIssueStatus(value: string | null | undefined) {
  return value === "done" || value === "cancelled";
}

function readPlanConfirmationTargetForIssue(payload: unknown, issueId: string) {
  const target = readObject(readObject(payload).target);
  if (target.type !== "issue_document" || target.key !== "plan") return null;
  // The interaction contract makes issueId optional; null/omitted means the
  // issue containing this interaction, just as target snapshot validation does.
  const targetIssueId = target.issueId == null ? issueId : readNonEmptyString(target.issueId);
  if (targetIssueId !== issueId) return null;
  return {
    issueId,
    documentId: readNonEmptyString(target.documentId),
    key: "plan",
    revisionId: readNonEmptyString(target.revisionId),
    revisionNumber:
      typeof target.revisionNumber === "number" ? target.revisionNumber : null,
  };
}

function readConfirmationResultForWake(result: unknown) {
  const parsed = readObject(result);
  if (Object.keys(parsed).length === 0) return null;
  return {
    outcome: readNonEmptyString(parsed.outcome),
    reason:
      readNonEmptyString(parsed.reason) ??
      readNonEmptyString(parsed.rejectionReason),
    commentId: readNonEmptyString(parsed.commentId),
  };
}

function readNativeCompletionReviewForWake(input: {
  payload: unknown;
  result: unknown;
  status: string;
}) {
  const target = readObject(readObject(input.payload).target);
  if (target.type !== "custom" || target.key !== "native_completion_review")
    return null;
  const result = readConfirmationResultForWake(input.result);
  return {
    decisionId: readNonEmptyString(target.revisionId),
    outcome: result?.outcome ?? input.status,
    reviewerReason: result?.reason ?? null,
    instruction:
      input.status === "rejected"
        ? "Address only the reviewer rejection for the accepted source run. Use the existing result and evidence; do not redo completed implementation or unrelated work."
        : "The completion review was resolved; preserve the accepted source-run result and disposition lineage.",
  };
}


export function readToolActionExecutionStatus(value: unknown) {
  return value === "approved" ||
    value === "executing" ||
    value === "executed" ||
    value === "failed" ||
    value === "expired"
    ? value
    : null;
}


function readToolActionContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const toolActionPayload = readObject(payload.toolAction);
  const toolName = readNonEmptyString(toolActionPayload.toolName);
  const actionRequestId = readNonEmptyString(toolActionPayload.actionRequestId);
  if (!toolName || !actionRequestId) return null;

  const result = readObject(interaction.result);
  const toolActionResult = readObject(result.toolAction);
  const declineReason =
    interaction.status === "rejected"
      ? readNonEmptyString(result.reason)
      : null;
  const error = readNonEmptyString(toolActionResult.errorMessage);
  const resultSummary = readNonEmptyString(toolActionResult.resultSummary);

  if (interaction.status === "rejected") {
    return {
      toolName,
      actionRequestId,
      decision: "rejected",
      executionStatus: "rejected",
      ...(declineReason ? { declineReason } : {}),
      instructions: `the action was declined${declineReason ? `: ${declineReason}` : ""}; do not retry the same call — adjust your approach or mark the task blocked/in_review with the decline reason.`,
    };
  }

  if (interaction.status !== "accepted") return null;
  const executionStatus = readToolActionExecutionStatus(
    toolActionResult.status,
  );
  if (!executionStatus) return null;

  if (executionStatus === "executed") {
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(resultSummary ? { resultSummary } : {}),
      instructions: `the approved ${toolName} action already ran — do not call the tool again; continue with this result.`,
    };
  }

  if (executionStatus === "failed") {
    const failureMessage = error ?? "an unknown error";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved action ran and failed with ${failureMessage}; adjust your approach — a fresh call will open a new approval.`,
    };
  }

  if (executionStatus === "expired") {
    const expirationMessage = error ? `: ${error}` : "";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved ${toolName} action expired before execution${expirationMessage}; if the task still requires it, call the tool again to request a fresh approval.`,
    };
  }

  return {
    toolName,
    actionRequestId,
    decision: "accepted",
    executionStatus,
    instructions: `the approved ${toolName} action is ${executionStatus}; do not call the tool again while this approval is being processed.`,
  };
}

function readSecretProposalContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const proposal = readObject(payload.secretProposal);
  const proposalId = readNonEmptyString(proposal.proposalId);
  const configPath = readNonEmptyString(proposal.configPath);
  if (!proposalId || !configPath) return null;
  const result = readObject(interaction.result);
  const execution = readObject(result.secretProposal);
  const executionStatus = readNonEmptyString(execution.status);
  const errorCode = readNonEmptyString(execution.errorCode);
  const sourceSecretLabel = readNonEmptyString(proposal.sourceSecretLabel);

  if (interaction.status === "rejected") {
    return {
      proposalId,
      configPath,
      decision: "rejected",
      executionStatus: "rejected",
      instructions:
        "the secret binding proposal was rejected; do not assume the alias exists.",
    };
  }
  if (
    interaction.status !== "accepted" ||
    (executionStatus !== "executed" && executionStatus !== "failed")
  ) {
    return null;
  }
  if (executionStatus === "executed") {
    return {
      proposalId,
      configPath,
      decision: "accepted",
      executionStatus,
      ...(sourceSecretLabel ? { sourceSecretLabel } : {}),
      instructions: `the binding was created at ${configPath}; verify it with GET /api/agents/me/secrets before using it.`,
    };
  }
  return {
    proposalId,
    configPath,
    decision: "accepted",
    executionStatus,
    ...(errorCode ? { errorCode } : {}),
    instructions:
      "the binding was not created; inspect the failure comment and submit a fresh proposal after fixing the cause.",
  };
}

const REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS = 2_000;

export function buildRequestItemVerdictsWakeIdempotencyKey(args: {
  issueId: string;
  interactionId: string;
  at?: Date;
}) {
  const now = args.at ?? new Date();
  const bucket = Math.floor(
    now.getTime() / REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS,
  );
  return `request_item_verdicts:${args.issueId}:${args.interactionId}:${bucket}`;
}

export async function queueResolvedInteractionContinuationWakeup(input: {
  db: Db;
  heartbeat: { wakeup(agentId: string, options?: WakeupOptions): Promise<unknown> };
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    status: string;
  };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
    payload?: unknown;
    result?: unknown;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
  newlyResolvedItemIds?: string[];
  idempotencyKey?: string | null;
}) {
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status))
    return;

  const reviewPathLost =
    input.issue.status === "in_review" &&
    (await issueService(input.db)
      .listReviewAttention(input.issue.companyId, [input.issue])
      .then((attention) => attention.get(input.issue.id)?.state === "stalled")
      .catch((err) => {
        logger.warn(
          { err, issueId: input.issue.id, interactionId: input.interaction.id },
          "failed to classify review path after issue interaction resolution",
        );
        return false;
      }));
  const continuationPolicyAllowsWake =
    input.interaction.continuationPolicy === "wake_assignee" ||
    (input.interaction.continuationPolicy === "wake_assignee_on_accept" &&
      // Question interactions resolve as `answered`, not `accepted`. An
      // authoritative answer is the positive resolution that this policy is
      // waiting for, just as acceptance is for confirmation interactions.
      (input.interaction.status === "accepted" ||
        input.interaction.status === "answered"));
  const rejectedPlanNeedsRevision =
    input.interaction.status === "rejected" &&
    input.interaction.kind === "request_confirmation" &&
    readPlanConfirmationTargetForIssue(
      input.interaction.payload,
      input.issue.id,
    ) !== null;
  // A plan confirmation presents rejection as "Request changes". That action
  // is incomplete unless the plan author receives the requested revisions,
  // even when an adapter/model selected the accept-only continuation policy.
  // Keep this as a resolution-time invariant so existing pending interactions
  // and future providers receive the same behavior.
  if (
    !continuationPolicyAllowsWake &&
    !rejectedPlanNeedsRevision &&
    !reviewPathLost
  )
    return;
  if (input.interaction.status === "expired" && !reviewPathLost) return;
  // A normal interaction continuation is itself the durable recovery path.
  // Do not contaminate that wake with the fallback "review path lost"
  // instruction merely because the just-consumed interaction now appears
  // stalled before its continuation has had a chance to run.
  const reviewPathContext =
    reviewPathLost &&
    !continuationPolicyAllowsWake &&
    !rejectedPlanNeedsRevision
      ? {
          reviewPathLost: true,
          reviewPathConsumedRef: input.interaction.id,
          reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
        }
      : null;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(
    input.workspaceRefreshReason,
  );
  const planTarget = readPlanConfirmationTargetForIssue(
    input.interaction.payload,
    input.issue.id,
  );
  const interactionResult = readConfirmationResultForWake(
    input.interaction.result,
  );
  const nativeCompletionReview = readNativeCompletionReviewForWake({
    payload: input.interaction.payload,
    result: input.interaction.result,
    status: input.interaction.status,
  });
  const checkboxSelection = readCheckboxSelectionForWake(input.interaction);
  const toolAction = readToolActionContinuationContext(input.interaction);
  const secretProposal = readSecretProposalContinuationContext(
    input.interaction,
  );
  const newlyResolvedItemIds =
    input.newlyResolvedItemIds?.filter((value) => value.length > 0) ?? [];
  const itemVerdicts =
    newlyResolvedItemIds.length > 0
      ? {
          newlyResolvedItemIds,
          coalesceWindowMs: REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS,
        }
      : null;
  const planReviewInteraction =
    planTarget && input.interaction.kind === "request_confirmation"
      ? {
          id: input.interaction.id,
          kind: input.interaction.kind,
          status: input.interaction.status,
          target: planTarget,
          acceptedTargetRevision:
            input.interaction.status === "accepted" ? planTarget : null,
          result: interactionResult,
        }
      : null;
  const genericRejectionReason =
    !planReviewInteraction &&
    !nativeCompletionReview &&
    input.interaction.status === "rejected" &&
    (input.interaction.kind === "request_confirmation" ||
      input.interaction.kind === "request_checkbox_confirmation")
      ? readNonEmptyString(readObject(input.interaction.result).reason)
      : null;
  const rejectionAgentMessage = genericRejectionReason
    ? {
        text: genericRejectionReason,
        source: "interaction_rejection",
        sessionId: input.interaction.id,
      }
    : null;
  const externalPromptPublications = await input.db
    .select({
      endpointId: chatPublications.endpointId,
      idempotencyKey: chatPublications.idempotencyKey,
      payload: chatPublications.payload,
    })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.companyId, input.issue.companyId),
        eq(chatPublications.issueId, input.issue.id),
        eq(
          sql<string>`${chatPublications.payload}->>'interactionId'`,
          input.interaction.id,
        ),
      ),
    );
  const hasExternalPromptBinding = externalPromptPublications.some(
    (publication) =>
      publication.idempotencyKey ===
      `interaction:${input.interaction.id}:${publication.endpointId}`,
  );
  await input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId: input.issue.id,
        interactionId: input.interaction.id,
        interactionKind: input.interaction.kind,
        interactionStatus: input.interaction.status,
        sourceCommentId: input.interaction.sourceCommentId ?? null,
        sourceRunId: input.interaction.sourceRunId ?? null,
        ...(planReviewInteraction ? { planReviewInteraction } : {}),
        ...(nativeCompletionReview ? { nativeCompletionReview } : {}),
        ...(checkboxSelection ? { checkboxSelection } : {}),
        ...(toolAction ? { toolAction } : {}),
        ...(secretProposal ? { secretProposal } : {}),
        ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
        ...(rejectionAgentMessage
          ? { paperclipAgentMessage: rejectionAgentMessage }
          : {}),
        ...(reviewPathContext ?? {}),
        mutation: "interaction",
      },
      idempotencyKey:
        input.idempotencyKey ??
        `interaction:${input.interaction.id}:${input.interaction.status}`,
      allowRunCoalescing: !hasExternalPromptBinding,
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        interactionId: input.interaction.id,
        interactionKind: input.interaction.kind,
        interactionStatus: input.interaction.status,
        sourceCommentId: input.interaction.sourceCommentId ?? null,
        sourceRunId: input.interaction.sourceRunId ?? null,
        ...(planReviewInteraction ? { planReviewInteraction } : {}),
        ...(nativeCompletionReview ? { nativeCompletionReview } : {}),
        ...(checkboxSelection ? { checkboxSelection } : {}),
        ...(toolAction ? { toolAction } : {}),
        ...(secretProposal ? { secretProposal } : {}),
        ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
        ...(rejectionAgentMessage
          ? { paperclipAgentMessage: rejectionAgentMessage }
          : {}),
        ...(reviewPathContext ?? {}),
        wakeReason: "issue_commented",
        source: input.source,
        ...(forceFreshSession ? { forceFreshSession: true } : {}),
        ...(workspaceRefreshReason ? { workspaceRefreshReason } : {}),
      },
    })
    .catch((err) =>
      logger.warn(
        {
          err,
          issueId: input.issue.id,
          interactionId: input.interaction.id,
          agentId: input.issue.assigneeAgentId,
        },
        "failed to wake assignee on issue interaction resolution",
      ),
    );
}

function readCheckboxSelectionForWake(input: {
  kind: string;
  payload?: unknown;
  result?: unknown;
}) {
  if (input.kind !== "request_checkbox_confirmation") return null;
  const result = readObject(input.result);
  if (result.outcome !== "accepted") return null;
  const selectedOptionIds = Array.isArray(result.selectedOptionIds)
    ? result.selectedOptionIds.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  const payload = readObject(input.payload);
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((value) => {
          const option = readObject(value);
          const id = readNonEmptyString(option.id);
          if (!id) return null;
          return {
            id,
            label: readNonEmptyString(option.label) ?? id,
            description: readNonEmptyString(option.description),
          };
        })
        .filter(
          (
            value,
          ): value is {
            id: string;
            label: string;
            description: string | null;
          } => Boolean(value),
        )
    : [];
  const optionById = new Map(options.map((option) => [option.id, option]));

  return {
    prompt: readNonEmptyString(payload.prompt),
    selectedOptionIds,
    selectedOptions: selectedOptionIds.map(
      (id) => optionById.get(id) ?? { id, label: id, description: null },
    ),
  };
}
