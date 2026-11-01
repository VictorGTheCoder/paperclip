import type { heartbeatRuns } from "@paperclipai/db";

type Run = typeof heartbeatRuns.$inferSelect;
export type PreclaimFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage";

/** Missing fields are not evidence that execution authority was never claimed. */
export function hasNeverClaimedInteractionResponse(run: Partial<Pick<Run, PreclaimFields>>): boolean {
  return run.startedAt === null && run.runtimeModeResolvedAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null;
}

/** Only the locked queued gate writes this run-bound receipt. It makes no
 * statement about stopping an already-started provider or preserving a session. */
export function isInteractionResponsePreclaimCancellation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> &
    Partial<Pick<Run, "id" | PreclaimFields>>,
): boolean {
  const receipt = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const cancellation = run.resultJson?.cancellation as Record<string, unknown> | undefined;
  return run.status === "cancelled" && run.errorCode === "interaction_response_not_current" &&
    run.resultJson?.stopReason === run.errorCode &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    typeof run.id === "string" && receipt?.runId === run.id &&
    receipt.kind === "interaction_response_preclaim" && receipt.providerWorkStarted === false &&
    cancellation?.source === "control_plane" && cancellation.expected === true &&
    (cancellation.initiator as Record<string, unknown> | undefined)?.type === "system" &&
    hasNeverClaimedInteractionResponse(run);
}
