import type { IssueExecutionStagePrincipal } from "./types/issue.js";
import { issueExecutionPolicySchema, issueExecutionStateSchema } from "./validators/issue.js";

/**
 * Review owner transfer moves the repair ownership of an issue that is in a
 * native review repair pass (`executionState.status = "changes_requested"`)
 * from the current return assignee to another agent. Only the issue assignee
 * and `executionState.returnAssignee` change; the stage, decision history,
 * round counter and policy are carried over untouched so later
 * changes-requested decisions route to the new owner and the policy's
 * `maxReviewRounds` cap keeps counting.
 */
export const REVIEW_OWNER_TRANSFER_REFUSAL_CODES = [
  "issue_terminal",
  "issue_status_incompatible",
  "no_native_review_workflow",
  "execution_state_invalid",
  "review_stage_missing",
  "not_review_stage",
  "human_participant_pending",
  "review_decision_pending",
  "not_in_repair_pass",
  "no_return_assignee",
  "return_assignee_not_agent",
  "expected_owner_mismatch",
  "assignee_drifted",
  "target_is_reviewer",
  "no_eligible_reviewer_after_transfer",
  // Host-level checks (database state the pure planner cannot see).
  "target_agent_not_found",
  "target_agent_not_assignable",
  "active_recovery_action",
  "scheduled_retry_pending",
  "owner_run_active",
] as const;
export type ReviewOwnerTransferRefusalCode = (typeof REVIEW_OWNER_TRANSFER_REFUSAL_CODES)[number];

/** HTTP status for each refusal: 409 for workflow state conflicts, 422 for an invalid request. */
export const REVIEW_OWNER_TRANSFER_REFUSAL_STATUS: Record<ReviewOwnerTransferRefusalCode, 409 | 422> = {
  issue_terminal: 409,
  issue_status_incompatible: 409,
  no_native_review_workflow: 422,
  execution_state_invalid: 409,
  review_stage_missing: 409,
  not_review_stage: 422,
  human_participant_pending: 409,
  review_decision_pending: 409,
  not_in_repair_pass: 409,
  no_return_assignee: 409,
  return_assignee_not_agent: 422,
  expected_owner_mismatch: 409,
  assignee_drifted: 409,
  target_is_reviewer: 422,
  no_eligible_reviewer_after_transfer: 422,
  target_agent_not_found: 422,
  target_agent_not_assignable: 409,
  active_recovery_action: 409,
  scheduled_retry_pending: 409,
  owner_run_active: 409,
};

/** Issue statuses in which a repair pass can legitimately sit. */
const REPAIR_PASS_ISSUE_STATUSES = new Set(["todo", "in_progress", "blocked"]);

export interface ReviewOwnerTransferIssueInput {
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: unknown;
  executionState?: unknown;
}

export interface ReviewOwnerTransferInput {
  issue: ReviewOwnerTransferIssueInput;
  targetAgentId: string;
  /**
   * Optional compare-and-set guard: the repair owner the caller believes is
   * current. A stale expectation is refused unless the issue has already
   * converged on the target (duplicate delivery stays a no-op).
   */
  expectedCurrentOwnerAgentId?: string | null;
}

export interface ReviewOwnerTransferSummary {
  stageId: string;
  changesRequestedCount: number;
  previousOwnerAgentId: string;
  ownerAgentId: string;
}

export type ReviewOwnerTransferPlan =
  | {
      ok: true;
      outcome: "noop";
      summary: ReviewOwnerTransferSummary;
    }
  | {
      ok: true;
      outcome: "transferred";
      summary: ReviewOwnerTransferSummary;
      /** The only fields the transfer writes. */
      patch: {
        assigneeAgentId: string;
        assigneeUserId: null;
        executionState: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      code: ReviewOwnerTransferRefusalCode;
      message: string;
      details?: Record<string, unknown>;
    };

function refuse(
  code: ReviewOwnerTransferRefusalCode,
  message: string,
  details?: Record<string, unknown>,
): ReviewOwnerTransferPlan {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function isAgentPrincipal(principal: IssueExecutionStagePrincipal | null | undefined, agentId: string) {
  return principal?.type === "agent" && principal.agentId === agentId;
}

/**
 * Pure decision for a review owner transfer. Fails closed: anything other
 * than an agent-owned repair pass on a native review stage is refused with a
 * stable code. Hosts add the database-backed checks (target agent validity,
 * recovery/retry/run state) and persist `patch` under a row lock.
 */
export function planReviewOwnerTransfer(input: ReviewOwnerTransferInput): ReviewOwnerTransferPlan {
  const { issue, targetAgentId } = input;

  if (issue.status === "done" || issue.status === "cancelled") {
    return refuse("issue_terminal", `Cannot transfer the review owner of a ${issue.status} issue`);
  }

  const policy = issue.executionPolicy == null ? null : issueExecutionPolicySchema.safeParse(issue.executionPolicy);
  if (!policy?.success || policy.data.stages.length === 0 || issue.executionState == null) {
    return refuse("no_native_review_workflow", "Issue has no native review workflow in progress");
  }
  const parsedState = issueExecutionStateSchema.safeParse(issue.executionState);
  if (!parsedState.success) {
    return refuse("execution_state_invalid", "Issue execution state is not a valid native review state");
  }
  const state = parsedState.data;

  if (state.status === "pending") {
    if (state.currentParticipant?.type === "user") {
      return refuse(
        "human_participant_pending",
        "A human participant holds the current review decision; the review owner cannot be transferred",
      );
    }
    return refuse(
      "review_decision_pending",
      "The review decision is still pending; transfer the owner during the repair pass after changes are requested",
    );
  }
  if (state.status !== "changes_requested" || !state.currentStageId) {
    return refuse("not_in_repair_pass", "Issue is not in a review repair pass", { executionStatus: state.status });
  }

  const stage = policy.data.stages.find((candidate) => candidate.id === state.currentStageId) ?? null;
  if (!stage) {
    return refuse("review_stage_missing", "The current review stage no longer exists in the execution policy");
  }
  if (stage.type !== "review") {
    return refuse("not_review_stage", "Only review stages support review owner transfer", { stageType: stage.type });
  }

  if (!REPAIR_PASS_ISSUE_STATUSES.has(issue.status)) {
    return refuse("issue_status_incompatible", `Issue status ${issue.status} is incompatible with a repair pass`);
  }

  const returnAssignee = state.returnAssignee;
  if (!returnAssignee) {
    return refuse("no_return_assignee", "The review stage has no return assignee");
  }
  if (returnAssignee.type !== "agent" || !returnAssignee.agentId) {
    return refuse("return_assignee_not_agent", "Only agent-owned repair passes can be transferred");
  }

  const summary: ReviewOwnerTransferSummary = {
    stageId: stage.id!,
    changesRequestedCount: state.changesRequestedCount ?? 0,
    previousOwnerAgentId: returnAssignee.agentId,
    ownerAgentId: targetAgentId,
  };

  const assigneeIsTarget = issue.assigneeAgentId === targetAgentId && !issue.assigneeUserId;
  if (returnAssignee.agentId === targetAgentId && assigneeIsTarget) {
    return { ok: true, outcome: "noop", summary };
  }

  if (
    input.expectedCurrentOwnerAgentId != null &&
    input.expectedCurrentOwnerAgentId !== returnAssignee.agentId
  ) {
    return refuse("expected_owner_mismatch", "The review owner changed since the caller observed it", {
      expectedCurrentOwnerAgentId: input.expectedCurrentOwnerAgentId,
      currentOwnerAgentId: returnAssignee.agentId,
    });
  }

  // The repair pass must be held by its owner, or already by the target (a
  // plain reassignment that never updated the return assignee).
  const assigneeIsOwner = issue.assigneeAgentId === returnAssignee.agentId && !issue.assigneeUserId;
  if (!assigneeIsOwner && !assigneeIsTarget) {
    return refuse("assignee_drifted", "The issue assignee no longer matches the review owner", {
      assigneeAgentId: issue.assigneeAgentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
      currentOwnerAgentId: returnAssignee.agentId,
    });
  }

  if (isAgentPrincipal(state.currentParticipant, targetAgentId)) {
    return refuse("target_is_reviewer", "The target agent is the reviewer of this stage");
  }
  const remainingReviewers = stage.participants.filter(
    (participant) => !(participant.type === "agent" && participant.agentId === targetAgentId),
  );
  if (remainingReviewers.length === 0) {
    return refuse(
      "no_eligible_reviewer_after_transfer",
      "The review stage would have no eligible reviewer once the target owns the repair",
    );
  }

  return {
    ok: true,
    outcome: "transferred",
    summary,
    patch: {
      assigneeAgentId: targetAgentId,
      assigneeUserId: null,
      // Spread the stored state so every other field is carried over verbatim.
      executionState: {
        ...(issue.executionState as Record<string, unknown>),
        returnAssignee: { type: "agent", agentId: targetAgentId, userId: null },
      },
    },
  };
}

const REFUSAL_MESSAGE_PREFIX = "review_owner_transfer_refused";
const REFUSAL_CODE_SET = new Set<string>(REVIEW_OWNER_TRANSFER_REFUSAL_CODES);

/**
 * Error message carried across transports that only preserve the message
 * (plugin worker RPC). Format: `review_owner_transfer_refused:<code>: <text>`.
 */
export function formatReviewOwnerTransferRefusal(code: ReviewOwnerTransferRefusalCode, message: string) {
  return `${REFUSAL_MESSAGE_PREFIX}:${code}: ${message}`;
}

/** Stable refusal code from an error (or message) raised by a refused transfer, else null. */
export function reviewOwnerTransferRefusalCode(error: unknown): ReviewOwnerTransferRefusalCode | null {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : null;
  if (!message) return null;
  const match = new RegExp(`${REFUSAL_MESSAGE_PREFIX}:([a-z_]+):`).exec(message);
  const code = match?.[1];
  return code && REFUSAL_CODE_SET.has(code) ? (code as ReviewOwnerTransferRefusalCode) : null;
}
