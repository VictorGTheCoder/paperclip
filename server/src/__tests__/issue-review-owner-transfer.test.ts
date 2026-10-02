import { describe, expect, it } from "vitest";
import {
  planReviewOwnerTransfer,
  type IssueExecutionPolicy,
  type IssueExecutionState,
} from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

const engineerA = "11111111-1111-4111-8111-111111111111";
const reviewerR = "22222222-2222-4222-8222-222222222222";
const seniorB = "33333333-3333-4333-8333-333333333333";
const seniorC = "44444444-4444-4444-8444-444444444444";
const humanH = "human-owner";

type SimIssue = {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  executionPolicy: IssueExecutionPolicy;
  executionState: IssueExecutionState | null;
};

function policyWithRounds(maxReviewRounds: number) {
  return normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerR }] }],
    maxReviewRounds,
  })!;
}

function applyPatch(issue: SimIssue, patch: Record<string, unknown>): SimIssue {
  return { ...issue, ...(patch as Partial<SimIssue>) };
}

/** Mirrors PATCH /issues/:id for the stage-transition fields the workflow owns. */
function patchIssue(
  issue: SimIssue,
  input: { actor: { agentId?: string; userId?: string }; status?: string; comment?: string; assigneeAgentId?: string },
): SimIssue {
  const result = applyIssueExecutionPolicyTransition({
    issue,
    policy: issue.executionPolicy,
    requestedStatus: input.status,
    requestedAssigneePatch: input.assigneeAgentId === undefined ? {} : { assigneeAgentId: input.assigneeAgentId },
    actor: input.actor,
    commentBody: input.comment ?? null,
  });
  const requested: Record<string, unknown> = {};
  if (input.status !== undefined) requested.status = input.status;
  if (input.assigneeAgentId !== undefined) requested.assigneeAgentId = input.assigneeAgentId;
  return applyPatch(issue, { ...requested, ...result.patch });
}

function submitForReview(issue: SimIssue, executor: string) {
  return patchIssue(issue, { actor: { agentId: executor }, status: "in_review", comment: "Ready for review" });
}

function requestChanges(issue: SimIssue, round: number) {
  return patchIssue(issue, { actor: { agentId: reviewerR }, status: "in_progress", comment: `Round ${round} feedback` });
}

function transfer(issue: SimIssue, targetAgentId: string, expectedCurrentOwnerAgentId?: string) {
  const plan = planReviewOwnerTransfer({ issue, targetAgentId, expectedCurrentOwnerAgentId });
  if (!plan.ok) throw new Error(`transfer refused: ${plan.code}`);
  return plan.outcome === "noop" ? issue : applyPatch(issue, plan.patch);
}

function freshIssue(maxReviewRounds: number): SimIssue {
  return {
    status: "in_progress",
    assigneeAgentId: engineerA,
    assigneeUserId: null,
    responsibleUserId: humanH,
    executionPolicy: policyWithRounds(maxReviewRounds),
    executionState: null,
  };
}

/** Engineer A → reviewer → changes requested ×rounds, leaving the issue in A's repair pass. */
function engineerRounds(rounds: number, maxReviewRounds = 6) {
  let issue = freshIssue(maxReviewRounds);
  for (let round = 1; round <= rounds; round += 1) {
    issue = submitForReview(issue, engineerA);
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(reviewerR);
    issue = requestChanges(issue, round);
    expect(issue.status).toBe("in_progress");
    expect(issue.assigneeAgentId).toBe(engineerA);
    expect(issue.executionState?.changesRequestedCount).toBe(round);
  }
  return issue;
}

describe("review owner transfer — native routing contract", () => {
  it("documents the pre-existing bug: a plain reassignment keeps routing changes back to the original engineer", () => {
    let issue = engineerRounds(3);
    // A plain assignee change during the repair pass does not touch the review workflow.
    issue = patchIssue(issue, { actor: { userId: humanH }, assigneeAgentId: seniorB });
    expect(issue.assigneeAgentId).toBe(seniorB);
    expect(issue.executionState?.returnAssignee).toEqual({ type: "agent", agentId: engineerA, userId: null });

    issue = submitForReview(issue, seniorB);
    issue = requestChanges(issue, 4);
    // Unchanged native behavior: previous.returnAssignee wins, so the work bounces to A.
    expect(issue.assigneeAgentId).toBe(engineerA);
  });

  it("routes Engineer ×3 → Senior ×3 → Human with one cumulative counter after a transfer", () => {
    let issue = engineerRounds(3);
    const stageId = issue.executionState!.currentStageId;
    const policyBefore = issue.executionPolicy;

    issue = transfer(issue, seniorB, engineerA);
    expect(issue.assigneeAgentId).toBe(seniorB);
    expect(issue.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      returnAssignee: { type: "agent", agentId: seniorB },
      changesRequestedCount: 3,
    });

    for (const round of [4, 5]) {
      issue = submitForReview(issue, seniorB);
      expect(issue.assigneeAgentId).toBe(reviewerR);
      expect(issue.executionState?.currentStageId).toBe(stageId);
      expect(issue.executionState?.returnAssignee).toMatchObject({ agentId: seniorB });
      issue = requestChanges(issue, round);
      expect(issue.status).toBe("in_progress");
      expect(issue.assigneeAgentId).toBe(seniorB);
      expect(issue.executionState).toMatchObject({
        status: "changes_requested",
        currentStageId: stageId,
        returnAssignee: { type: "agent", agentId: seniorB },
        changesRequestedCount: round,
      });
    }

    issue = submitForReview(issue, seniorB);
    issue = requestChanges(issue, 6);
    // maxReviewRounds = 6 is still honored: round 6 escalates to the responsible human.
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBeNull();
    expect(issue.assigneeUserId).toBe(humanH);
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      currentParticipant: { type: "user", userId: humanH },
      returnAssignee: { type: "agent", agentId: seniorB },
      changesRequestedCount: 6,
    });
    expect(issue.executionPolicy).toEqual(policyBefore);

    // A plugin cannot replace the pending human.
    const refused = planReviewOwnerTransfer({ issue, targetAgentId: seniorC });
    expect(refused).toMatchObject({ ok: false, code: "human_participant_pending" });

    // The human's Request changes returns the work to the transferred owner.
    issue = patchIssue(issue, { actor: { userId: humanH }, status: "in_progress", comment: "Human direction" });
    expect(issue.status).toBe("in_progress");
    expect(issue.assigneeAgentId).toBe(seniorB);
    expect(issue.executionState).toMatchObject({
      status: "changes_requested",
      returnAssignee: { type: "agent", agentId: seniorB },
      // Native behavior (unchanged): a human decision resets the agent round counter.
      changesRequestedCount: 0,
    });
  });
});

describe("planReviewOwnerTransfer", () => {
  const twoStagePolicy = normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewerR }] },
      { type: "review", participants: [{ type: "agent", agentId: seniorC }, { type: "agent", agentId: reviewerR }] },
      { type: "approval", participants: [{ type: "user", userId: humanH }] },
    ],
    maxReviewRounds: 6,
  })!;
  const [firstStage, secondStage, approvalStage] = twoStagePolicy.stages;

  function repairPass(stateOverrides: Record<string, unknown> = {}, issueOverrides: Record<string, unknown> = {}) {
    return {
      status: "in_progress",
      assigneeAgentId: engineerA,
      assigneeUserId: null,
      executionPolicy: twoStagePolicy,
      executionState: {
        status: "changes_requested",
        currentStageId: secondStage!.id,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerR, userId: null },
        returnAssignee: { type: "agent", agentId: engineerA, userId: null },
        reviewRequest: { instructions: "Check the migration path" },
        completedStageIds: [firstStage!.id],
        lastDecisionId: "99999999-9999-4999-8999-999999999999",
        lastDecisionOutcome: "changes_requested",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-10-02T00:00:00.000Z",
          lastTriggeredAt: null,
          attemptCount: 1,
          notes: "watch CI",
          scheduledBy: "assignee",
          clearedAt: null,
          clearReason: null,
        },
        changesRequestedCount: 3,
        ...stateOverrides,
      },
      ...issueOverrides,
    };
  }

  it("changes only the assignee and returnAssignee, carrying every other state field verbatim", () => {
    const issue = repairPass();
    const plan = planReviewOwnerTransfer({ issue, targetAgentId: seniorB });
    expect(plan).toMatchObject({ ok: true, outcome: "transferred" });
    if (!plan.ok || plan.outcome !== "transferred") throw new Error("unreachable");
    expect(Object.keys(plan.patch).sort()).toEqual(["assigneeAgentId", "assigneeUserId", "executionState"]);
    expect(plan.patch.assigneeAgentId).toBe(seniorB);
    expect(plan.patch.executionState).toEqual({
      ...issue.executionState,
      returnAssignee: { type: "agent", agentId: seniorB, userId: null },
    });
    expect(plan.summary).toEqual({
      stageId: secondStage!.id,
      changesRequestedCount: 3,
      previousOwnerAgentId: engineerA,
      ownerAgentId: seniorB,
    });
  });

  it("is a no-op once the target owns both the assignment and the hand-back", () => {
    const issue = repairPass(
      { returnAssignee: { type: "agent", agentId: seniorB, userId: null } },
      { assigneeAgentId: seniorB },
    );
    expect(planReviewOwnerTransfer({ issue, targetAgentId: seniorB })).toMatchObject({ ok: true, outcome: "noop" });
    // A stale compare-and-set from the duplicate delivery still converges.
    expect(
      planReviewOwnerTransfer({ issue, targetAgentId: seniorB, expectedCurrentOwnerAgentId: engineerA }),
    ).toMatchObject({ ok: true, outcome: "noop" });
  });

  it("allows a target that is a non-current participant while another reviewer remains", () => {
    expect(planReviewOwnerTransfer({ issue: repairPass(), targetAgentId: seniorC })).toMatchObject({
      ok: true,
      outcome: "transferred",
    });
  });

  const refusals: Array<[string, () => Parameters<typeof planReviewOwnerTransfer>[0], string]> = [
    ["done issue", () => ({ issue: repairPass({}, { status: "done" }), targetAgentId: seniorB }), "issue_terminal"],
    ["cancelled issue", () => ({ issue: repairPass({}, { status: "cancelled" }), targetAgentId: seniorB }), "issue_terminal"],
    ["no policy", () => ({ issue: repairPass({}, { executionPolicy: null }), targetAgentId: seniorB }), "no_native_review_workflow"],
    ["no execution state", () => ({ issue: repairPass({}, { executionState: null }), targetAgentId: seniorB }), "no_native_review_workflow"],
    ["corrupt state", () => ({ issue: repairPass({ status: "bogus" }), targetAgentId: seniorB }), "execution_state_invalid"],
    [
      "agent decision pending",
      () => ({ issue: repairPass({ status: "pending" }, { status: "in_review", assigneeAgentId: reviewerR }), targetAgentId: seniorB }),
      "review_decision_pending",
    ],
    [
      "human escalation pending",
      () => ({
        issue: repairPass(
          { status: "pending", currentParticipant: { type: "user", agentId: null, userId: humanH }, changesRequestedCount: 6 },
          { status: "in_review", assigneeAgentId: null, assigneeUserId: humanH },
        ),
        targetAgentId: seniorB,
      }),
      "human_participant_pending",
    ],
    [
      "completed workflow",
      () => ({ issue: repairPass({ status: "completed", currentStageId: null }), targetAgentId: seniorB }),
      "not_in_repair_pass",
    ],
    [
      "stage removed from policy",
      () => ({ issue: repairPass({ currentStageId: "88888888-8888-4888-8888-888888888888" }), targetAgentId: seniorB }),
      "review_stage_missing",
    ],
    [
      "approval stage",
      () => ({ issue: repairPass({ currentStageId: approvalStage!.id, currentStageType: "approval" }), targetAgentId: seniorB }),
      "not_review_stage",
    ],
    [
      "inconsistent in_review status",
      () => ({ issue: repairPass({}, { status: "in_review" }), targetAgentId: seniorB }),
      "issue_status_incompatible",
    ],
    ["missing return assignee", () => ({ issue: repairPass({ returnAssignee: null }), targetAgentId: seniorB }), "no_return_assignee"],
    [
      "human repair owner",
      () => ({
        issue: repairPass({ returnAssignee: { type: "user", agentId: null, userId: humanH } }, { assigneeAgentId: null, assigneeUserId: humanH }),
        targetAgentId: seniorB,
      }),
      "return_assignee_not_agent",
    ],
    [
      "stale compare-and-set",
      () => ({ issue: repairPass(), targetAgentId: seniorB, expectedCurrentOwnerAgentId: seniorC }),
      "expected_owner_mismatch",
    ],
    [
      "assignee drifted to a third agent",
      () => ({ issue: repairPass({}, { assigneeAgentId: seniorC }), targetAgentId: seniorB }),
      "assignee_drifted",
    ],
    ["reviewer as target", () => ({ issue: repairPass(), targetAgentId: reviewerR }), "target_is_reviewer"],
  ];

  it.each(refusals)("fails closed: %s", (_label, input, code) => {
    expect(planReviewOwnerTransfer(input())).toMatchObject({ ok: false, code });
  });

  it("refuses when the target is the only reviewer of the stage", () => {
    const soloPolicy = policyWithRounds(6);
    const soloStage = soloPolicy.stages[0]!;
    const plan = planReviewOwnerTransfer({
      issue: {
        status: "in_progress",
        assigneeAgentId: engineerA,
        executionPolicy: soloPolicy,
        executionState: {
          status: "changes_requested",
          currentStageId: soloStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          // Participant of record differs from the only configured reviewer.
          currentParticipant: { type: "agent", agentId: seniorC, userId: null },
          returnAssignee: { type: "agent", agentId: engineerA, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 1,
        },
      },
      targetAgentId: reviewerR,
    });
    expect(plan).toMatchObject({ ok: false, code: "no_eligible_reviewer_after_transfer" });
  });
});
