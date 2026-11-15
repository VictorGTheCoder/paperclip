# Dependency wakes and deliberate stops

A task can remain blocked after all recorded dependencies finish. Its assignee
may be waiting for an external action. Blocking its own task does not request
another dependency wake. The periodic recovery sweep preserves this decision,
including native status decisions attributed to the assignee's bound run.

Title, monitor, and other unrelated edits do not change this wait. A later
assignment, status, or blocker-set update permits reconciliation again. A blocker
that completes or finishes workspace export after the wait also permits a wake.
The export must name the blocker issue. An export from the waiting task or an
unattributed operation in the same shared workspace does not remove its wait.
Normal readiness, duplicate-wake, interaction, pause, and execution gates still
apply. A board transition into blocked keeps the existing recovery behavior.

A dependency completion can arrive while the assignee answers a question about
the blocked task. Its saved wake waits behind that turn. Deferred-receipt recovery
reconstructs these dependency wakes after the turn and its cleanup finish, even
when they contain no comment or interaction response. It uses the existing
release and dispatch checks; task cancellation, agent pause, and pending cleanup
still prevent execution.

Cancelling a run or pausing its agent suppresses immediate stranded-work recovery.
A queued user message remains a separate continuation request. The release path
still preserves independently authorized deferred input; stopping the old run
does not discard that input or grant permission to replay its old tools.

## Addressed question respondent recovery

An `interaction_response_requested` wake retains the exact `interactionId` from
its payload across queue persistence. Before dispatch, the server reloads that
pending `ask_user_questions` card in the same company/task and rechecks the
current recipient and resolver audience. Missing, malformed, resolved, foreign,
or human-only cards do not grant an ownership exception. Another pending card
cannot authorize the request. This path does not reassign the worker's task,
make the respondent a review participant, or bypass terminality or admission
gates. An accepted wake, provider execution, saved answer and worker continuation
remain distinct outcomes. A repeated intention uses its existing idempotency key.

For this request kind, the same agent/task/question/actor and idempotency key
reuse the original persistent receipt under the issue admission lock, including
concurrent requests and replay after controller reconstruction. Reusing the key
for another intention returns a conflict. A terminal run is not automatically
re-executed; failures still require their supported recovery path. This is not a
global idempotency change for unrelated wake kinds.
