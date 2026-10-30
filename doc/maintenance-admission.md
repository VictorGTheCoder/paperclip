# Bounded operator maintenance admission

`PAPERCLIP_MAINTENANCE_REQUIRED=1` enables a fail-closed admission restriction.
Set `PAPERCLIP_MAINTENANCE_POLICY` to an absolute root-owned JSON file in a
root-owned directory without group/world write permission, and
`PAPERCLIP_MAINTENANCE_AUDIT` to an absolute writable private JSONL journal.
Do not put either file in an agent workspace. These are operator controls,
not protection against an administrator or the existing shared OS identity.

The existing board-authenticated task-drain status includes `maintenance.bootId`.
Every new application process creates a new random boot ID. Starting, restarting,
removing a policy, malformed policy, journal errors, expiry and stale boot IDs all
HOLD admission. Stopping the ordinary task drain cannot release this fence.
Existing work admitted before closing may finish; close the ordinary drain and
wait for controllers, pending claims and leases to settle before artifact changes.

The operator atomically replaces the policy only after checking the exact build
and the currently running boot ID. An issue window has this shape:

```json
{"version":1,"mode":"issue","bootId":"CURRENT-BOOT-ID","windowId":"APPROVED-WINDOW-ID","companyId":"CANONICAL-COMPANY-UUID","issueId":"CANONICAL-ISSUE-UUID","agentIds":["ARCHITECT-UUID","VICTOR-UUID"],"expiresAt":"UTC-DEADLINE","maxRuns":6}
```

A window lasts at most twenty minutes. Only persisted run company/issue/agent
identities can match. Conflicting native issue IDs are denied. A synchronous,
fsynced journal reserves at most six distinct run IDs per window before claims.
Failed or rolled-back claims consume slots; no automatic refunds. Repeated
attempts on the same native run retain normal recovery budgets. Changing boot ID
or rearming the same window does not reset reservations. Root must not change
windowId to extend an exhausted test without renewed authorization.

Checks restrict both ordinary and queued-comment claims, native review claims,
native same-run and restart recovery claims, and execution entry. They never
replace recipient checks, company membership, invokability, budgets, revision
checks, approvals or existing recovery permissions. Deferred comment sweeps leave excluded receipts untouched. Completion cleanup
may release locks and promote receipts durably; admission still prevents execution. Cancellation remains native and
cannot be undone by releasing maintenance. Completed work, documents, approvals
and next actions remain in the database.

`mode: "hold"` closes the fence. `mode: "released"` explicitly lifts the issue
restriction only for the current boot and unexpired window; normal gates still
apply. Neither is an execution approval. Release is allowed only after an operator
reconciles queues under the approved procedure. Keep the required environment in
the service until maintenance is complete. An unexpected restart invalidates
both issue and released policies. The baseline artifact does not know this
module: start rollback through the already rehearsed pre-entrypoint indefinite
native drain, keep all external ingress/dispatch held, and never lift it until
rollback verification and explicit dispatch-release authorization.

This fence is admission containment, not per-agent filesystem/network isolation.
Do not infer that a completed result's reconciliation is a new model execution.
Do not use it to adopt an existing live provider: the production precondition is
clean quiescence and no remaining provider/controller process before activation.
