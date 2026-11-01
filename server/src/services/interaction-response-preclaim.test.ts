import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const unclaimed = {
  id: "run-one", runtimeMode: "legacy", status: "cancelled",
  errorCode: "interaction_response_not_current", scheduledRetryAttempt: 3,
  startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
  processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
  controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
  resultJson: {
    stopReason: "interaction_response_not_current", timeoutSource: "stale_queued_run_gate",
    cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } },
    executionRecovery: { kind: "interaction_response_preclaim", runId: "run-one", providerWorkStarted: false },
  },
};

it("recognizes only the dedicated never-claimed receipt before exhausted retry accounting", () => {
  expect(legacyExecutionNeedsReconciliation(unclaimed)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, errorCode: "issue_assignee_changed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, id: "another-run" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, resultJson: {
    ...unclaimed.resultJson, workspaceRestoreFailure: "restore_unsafe_archive",
  } })).toBe(true);
});

it.each([
  "startedAt", "runtimeModeResolvedAt", "processPid", "processGroupId", "processStartedAt",
  "nativeIssueId", "nativeSessionId", "sessionIdAfter", "controllerBootId",
  "controllerLeaseExpiresAt", "executionStage",
] as const)("does not trust a receipt with missing or conflicting %s", field => {
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, [field]: undefined })).toBe(true);
  // Conflicting retained execution evidence defeats the receipt regardless of its shape.
  const conflicting = { ...unclaimed, [field]: "recorded" } as unknown as typeof unclaimed;
  expect(legacyExecutionNeedsReconciliation(conflicting)).toBe(true);
});

it("does not infer expected intent or no-provider work from an incomplete receipt", () => {
  for (const cancellation of [null, { ...unclaimed.resultJson.cancellation, expected: false },
    { ...unclaimed.resultJson.cancellation, source: "operator" }]) {
    expect(legacyExecutionNeedsReconciliation({ ...unclaimed, resultJson: {
      ...unclaimed.resultJson, cancellation,
    } })).toBe(true);
  }
  expect(legacyExecutionNeedsReconciliation({ ...unclaimed, resultJson: {
    ...unclaimed.resultJson, executionRecovery: {
      ...unclaimed.resultJson.executionRecovery, providerWorkStarted: true,
    },
  } })).toBe(true);
});
