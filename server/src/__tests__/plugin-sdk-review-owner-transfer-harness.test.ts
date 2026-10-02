import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Agent, Issue, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";
import { reviewOwnerTransferRefusalCode } from "../../../packages/plugins/sdk/src/index.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-review-owner",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Review owner transfer harness",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function seedState() {
  const companyId = randomUUID();
  const engineerA = randomUUID();
  const reviewerR = randomUUID();
  const seniorB = randomUUID();
  const policy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerR }] }],
    maxReviewRounds: 6,
  })!;
  const now = new Date();
  const issue = {
    id: randomUUID(),
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Repair pass",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: engineerA,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    executionPolicy: policy,
    executionState: {
      status: "changes_requested",
      currentStageId: policy.stages[0]!.id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerR, userId: null },
      returnAssignee: { type: "agent", agentId: engineerA, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 3,
    },
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  } as unknown as Issue;
  const agent = (id: string, status = "idle") => ({ id, companyId, name: id, status } as unknown as Agent);
  return { companyId, engineerA, reviewerR, seniorB, issue, agents: [agent(engineerA), agent(reviewerR), agent(seniorB)] };
}

describe("plugin SDK test harness: ctx.issues.transferReviewOwner", () => {
  it("applies the same transition as the host and converges on redelivery", async () => {
    const s = seedState();
    const harness = createTestHarness({ manifest: manifest(["issues.read", "issues.review.transfer_owner"]) });
    harness.seed({ issues: [s.issue], agents: s.agents });

    const first = await harness.ctx.issues.transferReviewOwner({
      issueId: s.issue.id,
      companyId: s.companyId,
      targetAgentId: s.seniorB,
      expectedCurrentOwnerAgentId: s.engineerA,
    });
    expect(first).toMatchObject({ outcome: "transferred", previousOwnerAgentId: s.engineerA, ownerAgentId: s.seniorB });
    const stored = await harness.ctx.issues.get(s.issue.id, s.companyId);
    expect(stored?.assigneeAgentId).toBe(s.seniorB);
    expect(stored?.executionState).toEqual({
      ...s.issue.executionState,
      returnAssignee: { type: "agent", agentId: s.seniorB, userId: null },
    });

    await expect(
      harness.ctx.issues.transferReviewOwner({
        issueId: s.issue.id,
        companyId: s.companyId,
        targetAgentId: s.seniorB,
        expectedCurrentOwnerAgentId: s.engineerA,
      }),
    ).resolves.toMatchObject({ outcome: "noop", changesRequestedCount: 3 });
  });

  it("requires the dedicated capability", async () => {
    const s = seedState();
    const harness = createTestHarness({ manifest: manifest(["issues.read", "issues.update"]) });
    harness.seed({ issues: [s.issue], agents: s.agents });
    await expect(
      harness.ctx.issues.transferReviewOwner({ issueId: s.issue.id, companyId: s.companyId, targetAgentId: s.seniorB }),
    ).rejects.toThrow(/issues\.review\.transfer_owner/);
  });

  it("raises the host's refusal codes", async () => {
    const s = seedState();
    const harness = createTestHarness({ manifest: manifest(["issues.review.transfer_owner"]) });
    harness.seed({ issues: [s.issue], agents: s.agents });
    const refused = (targetAgentId: string) =>
      harness.ctx.issues
        .transferReviewOwner({ issueId: s.issue.id, companyId: s.companyId, targetAgentId })
        .catch((error: unknown) => reviewOwnerTransferRefusalCode(error));
    expect(await refused(randomUUID())).toBe("target_agent_not_found");
    expect(await refused(s.reviewerR)).toBe("target_is_reviewer");
  });
});
