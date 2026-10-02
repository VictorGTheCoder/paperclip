import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueRecoveryActions } from "@paperclipai/db";
import {
  REVIEW_OWNER_TRANSFER_REFUSAL_STATUS,
  formatReviewOwnerTransferRefusal,
  planReviewOwnerTransfer,
  type ReviewOwnerTransferRefusalCode,
  type ReviewOwnerTransferSummary,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { issueService } from "./issues.js";

/** Recovery action statuses that still own the issue's next step. */
const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"];
/**
 * Old-owner run statuses that would keep working the repair after the
 * transfer. Queued runs are deliberately absent: the heartbeat cancels a
 * queued run whose issue assignee changed before it starts.
 */
const OWNER_RUN_BLOCKING_STATUSES = ["running", "scheduled_retry"];

export type ReviewOwnerTransferActor =
  | { actorType: "user"; actorId: string; agentApiKeyId?: null }
  | { actorType: "plugin"; actorId: string; agentId?: string | null; runId?: string | null };

export interface TransferReviewOwnerInput {
  companyId: string;
  issueId: string;
  targetAgentId: string;
  expectedCurrentOwnerAgentId?: string | null;
  reason?: string | null;
  actor: ReviewOwnerTransferActor;
  /** Caller attribution merged into the activity entry (e.g. plugin source fields). */
  activityDetails?: Record<string, unknown>;
}

export class ReviewOwnerTransferRefusedError extends HttpError {
  readonly code: ReviewOwnerTransferRefusalCode;

  constructor(code: ReviewOwnerTransferRefusalCode, message: string, details?: Record<string, unknown>) {
    // The code travels in the message too: the plugin worker RPC only carries messages.
    super(REVIEW_OWNER_TRANSFER_REFUSAL_STATUS[code], formatReviewOwnerTransferRefusal(code, message), {
      code,
      ...(details ?? {}),
    });
    this.name = "ReviewOwnerTransferRefusedError";
    this.code = code;
  }
}

/**
 * The single implementation of the review owner transfer. The REST route and
 * the plugin host both call `transfer`; neither carries its own logic.
 *
 * The transition runs in one transaction under the issue row lock, so
 * concurrent transfers serialize: the second observes the first's result and
 * either converges (same target, no-op) or applies a fresh owner change.
 * It never enqueues a wake — waking the new owner stays with the caller.
 */
export function issueReviewOwnerTransferService(db: Db) {
  const issues = issueService(db);

  async function assertTargetAgent(tx: Db, companyId: string, targetAgentId: string) {
    const target = await tx
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .then((rows) => rows[0] ?? null);
    // Another company's agent is reported exactly like a missing one.
    if (!target || target.companyId !== companyId) {
      throw new ReviewOwnerTransferRefusedError("target_agent_not_found", "Target agent not found in this company");
    }
    try {
      await assertAssignableAgent(tx, companyId, targetAgentId, { kind: "work" });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new ReviewOwnerTransferRefusedError("target_agent_not_assignable", err.message, {
          reason: (err.details as Record<string, unknown> | undefined)?.reason ?? null,
        });
      }
      throw err;
    }
  }

  async function assertNoActiveRecoveryAction(tx: Db, companyId: string, issueId: string) {
    const active = await tx
      .select({ id: issueRecoveryActions.id, status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        inArray(issueRecoveryActions.status, ACTIVE_RECOVERY_ACTION_STATUSES),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (active) {
      throw new ReviewOwnerTransferRefusedError(
        "active_recovery_action",
        "An active recovery action owns this issue; resolve it before transferring the review owner",
        { recoveryActionId: active.id, recoveryActionStatus: active.status },
      );
    }
  }

  async function assertNoOwnerRunInFlight(
    tx: Db,
    issue: { id: string; companyId: string; executionRunId: string | null; checkoutRunId: string | null },
    previousOwnerAgentIds: string[],
  ) {
    if (previousOwnerAgentIds.length === 0) return;
    const lockRunIds = [issue.executionRunId, issue.checkoutRunId].filter((id): id is string => Boolean(id));
    const issueMatch = sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`;
    const run = await tx
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, issue.companyId),
        inArray(heartbeatRuns.agentId, previousOwnerAgentIds),
        inArray(heartbeatRuns.status, OWNER_RUN_BLOCKING_STATUSES),
        lockRunIds.length > 0 ? or(issueMatch, inArray(heartbeatRuns.id, lockRunIds)) : issueMatch,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run) return;
    if (run.status === "scheduled_retry") {
      throw new ReviewOwnerTransferRefusedError(
        "scheduled_retry_pending",
        "The current review owner has a scheduled retry on this issue",
        { runId: run.id, agentId: run.agentId },
      );
    }
    throw new ReviewOwnerTransferRefusedError(
      "owner_run_active",
      "The current review owner is still running on this issue",
      { runId: run.id, agentId: run.agentId },
    );
  }

  return {
    async transfer(input: TransferReviewOwnerInput) {
      const activityPublications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const locked = await issues.getByIdForUpdate(input.issueId, tx);
        if (!locked || locked.companyId !== input.companyId) throw notFound("Issue not found");

        const plan = planReviewOwnerTransfer({
          issue: locked,
          targetAgentId: input.targetAgentId,
          expectedCurrentOwnerAgentId: input.expectedCurrentOwnerAgentId ?? null,
        });
        if (!plan.ok) throw new ReviewOwnerTransferRefusedError(plan.code, plan.message, plan.details);
        // Duplicate delivery converges without writing, logging or waking.
        if (plan.outcome === "noop") {
          return { outcome: "noop" as const, summary: plan.summary, issue: locked };
        }

        const txDb = tx as unknown as Db;
        await assertTargetAgent(txDb, input.companyId, input.targetAgentId);
        await assertNoActiveRecoveryAction(txDb, input.companyId, locked.id);
        const previousOwnerAgentIds = [plan.summary.previousOwnerAgentId, locked.assigneeAgentId]
          .filter((id): id is string => Boolean(id) && id !== input.targetAgentId);
        await assertNoOwnerRunInFlight(txDb, locked, [...new Set(previousOwnerAgentIds)]);

        const updated = await issues.update(
          locked.id,
          {
            ...plan.patch,
            actorAgentId: input.actor.actorType === "plugin" ? input.actor.agentId ?? null : null,
            actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          },
          tx,
          activityPublications,
        );
        if (!updated) throw notFound("Issue not found");

        await logActivity(txDb, {
          companyId: locked.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.actorType === "plugin" ? input.actor.agentId ?? null : null,
          runId: input.actor.actorType === "plugin" ? input.actor.runId ?? null : null,
          action: "issue.review_owner_transferred",
          entityType: "issue",
          entityId: locked.id,
          details: {
            identifier: locked.identifier,
            stageId: plan.summary.stageId,
            changesRequestedCount: plan.summary.changesRequestedCount,
            previousOwnerAgentId: plan.summary.previousOwnerAgentId,
            ownerAgentId: plan.summary.ownerAgentId,
            previousAssigneeAgentId: locked.assigneeAgentId,
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
            ...(input.activityDetails ?? {}),
          },
        }, activityPublications);

        return { outcome: "transferred" as const, summary: plan.summary, issue: updated };
      });
      for (const publication of activityPublications) publishActivity(publication);
      // Re-read so both outcomes return the same enriched issue shape.
      const issue = await issues.getById(input.issueId);
      if (!issue) throw notFound("Issue not found");
      return { outcome: result.outcome, summary: result.summary as ReviewOwnerTransferSummary, issue };
    },
  };
}
