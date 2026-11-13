# Version-correct Codex ACP linked-Git metadata repair

## Installed source and purpose

This patch targets live Paperclip 2026.1012.0 source commit
`82eef2bca238c3f9362e965b20a8b030244e8f41`, not the newer canonical checkout.
It supersedes the deployment applicability of draft fork PR #9 while preserving
that investigation and history. Existing TFT Engineer workspace Git operations
fail EROFS inside Codex ACP because a linked worktree's common Git metadata
is outside its source directory. Host filesystem mode is not a worker proof.

## Runtime lanes and correction

The production TFT agents use `adapterType: codex_local`, `engine: acp`, and the
legacy heartbeat executor. Their worker command is the configured
`@agentclientprotocol/codex-acp@1.6.2` entry point; the Engineer's existing
custom `agentCommand` points to its older installed package path. They are not
`paperclip_runner` agents.

The earlier native-only projection did not repair that worker. Heartbeat
preparation computes `PAPERCLIP_GIT_METADATA_ROOTS`, but
`packages/adapter-utils/src/acpx-engine/execute.ts` independently builds the
ACP launch environment and does not call that preparation function. In
addition, the legacy Codex ACP launch does not set
`PAPERCLIP_ACPX_ISOLATED_CONTEXT`. The previous candidate's Git-root helper
therefore returned no roots for this production lane. The native
`paperclip_runner` route uses a verified build-owned provider profile, so
`agentCommand` is not its supported candidate selector.

The narrow legacy seam now derives Git context inside the ACP executor from
its controller-owned admitted execution target and effective cwd, using
`prepareGitHubExecutionEnvironment`. It passes an empty environment to that
probe and consumes only its controller-probed Git roots. It replaces configured
root values and sets `PAPERCLIP_ACPX_GIT_METADATA_SCOPE=1` only when roots were
found. Adapter configuration cannot set this marker; ambient process variables
are not used as the source. The candidate Codex ACP patch accepts either the
native isolated-context marker or this separate Git-only marker when adding
validated real Git metadata directories to Codex session/turn writable roots.
The legacy executor does not set `PAPERCLIP_ACPX_ISOLATED_CONTEXT`, so this
does not activate native skills, MCP, auth, or other isolation changes. It does
not widen network/auth policy or add Git metadata to skill, MCP, project-trust,
or general filesystem roots.

The source change is a candidate repair for the legacy lane, not a production
qualification. A source test that constructs a session environment does not
prove that the actual worker received the roots or could write only within
them. Native route source tests remain useful for the native route only.

The installed Codex 0.160.0 dependency and existing native source patch behavior
(system prompt, approvals, skills, networking, goal publishing) remain in the
candidate. Reapplying the current patch to pristine npm package bytes from the
pinned Git HEAD produced executable digest
`sha256:68fda4e34fae33ab680af094956f6a5f08f77047d59d33c68968d6ae2fc3e3c8`.
Native-session artifact declarations now match those bytes, but apply only to
the native route; legacy worker qualification needs separate source review and
a real-worker probe. This matching declaration is not itself a production
qualification certificate.

## Verification and packaging

The patch was applied to pristine npm package bytes archived from the pinned
Git HEAD in `/mnt/wd4tb/tft-codex-acp-patch-20261112/original`; the checked-out
files in that directory were modified, so they were not used as package input.
`node --check dist/index.js` passed. The resulting digest is
`68fda4e34fae33ab680af094956f6a5f08f77047d59d33c68968d6ae2fc3e3c8`.

Focused checks passed: the ACP executor tests for controller-root forwarding,
configured root/marker rejection, and ambient/configured-cwd rejection (3
passed, 210 skipped); the Codex package contract test against that candidate
executable (11 passed); candidate `node --check`; and `git diff --check`. These
checks validate source wiring and artifact identity, not writes made by the
actual legacy worker. A separate existing helper test for the local
host-credential path failed in this sandbox with `Could not read
execution-target Git context`; the focused SSH target-root helper test passed.
`pnpm-lock.yaml` is intentionally unchanged because existing repository policy
makes lock regeneration CI-owned. A release builder must regenerate the patch
hash through the supported CI process and retain the resulting locked artifact;
manual lockfile exceptions and fake bot authors are not allowed.

## Bounded actual-worker test and rollout

Before global installation, qualify a separately built candidate containing
**both** this controller/adapter executor change and the exact Codex ACP package.
A task-scoped `agentCommand` override changes only the executable: against the
unchanged live controller it does **not** install the new Git-root discovery
and must not be represented as an end-to-end repair test. Use an isolated
candidate controller/runner qualification environment with its own test state,
not copied live credentials/database or a manually injected scope marker.
Only once that environment executes the candidate adapter code may the legacy
`codex_local` worker select its immutable package through `agentCommand`, with
`engine=acp`, model, credential and approval policy unchanged. The native route
must use its build-owned verified profile and cannot be selected with
`agentCommand`. The isolated qualification path is a required delivery step,
not implemented or certified by this source patch alone.
The actual legacy worker must create/read/delete nonce files in its own worktree
and each controller-resolved Git metadata directory, and fail to write an
unrelated operator-prepared directory under the same OS user. Only that proof,
not host permissions or synthetic environment tests, can establish the EROFS
repair. No Git commit/fetch/rebase/push or user file change is authorized by the
probe. Abort on unexpected paths or unrestricted sandbox behavior.

Global runtime deployment still requires independent source review, qualified
release/CI artifact, zero live runs, private rollback backup, installed source
and byte readback, health checks and current-state verification. Do not directly
patch the live package store or silently switch to a less-confined CLI engine.


## Independent revalidation on November 13

The complete actual-release ACP executor suite passed **213/213** with the
original default five-second test budget and one test worker. An earlier run
under concurrent compiler/CI load had five timing failures (208 passed); the
remaining two timing cases passed on both unchanged installed source and the
patched candidate without code/test-timeout changes, before the full successful
rerun. Preserve the earlier logs as load-sensitive evidence, not a first-pass
success claim. The exact candidate package contract also passed **11/11**.
No new runtime qualification, live deployment, API key, permission, sandbox
mode, or GitHub CI success is implied by these source tests.
