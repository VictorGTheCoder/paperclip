# Version-correct Codex ACP linked-Git metadata repair

## Installed source and purpose

This patch targets live Paperclip 2026.1012.0 source commit
`82eef2bca238c3f9362e965b20a8b030244e8f41`, not the newer canonical checkout.
It supersedes the deployment applicability of draft fork PR #9 while preserving
that investigation and history. Existing TFT Engineer workspace Git operations
fail EROFS inside Codex ACP because a linked worktree's common Git metadata
is outside its source directory. Host filesystem mode is not a worker proof.

## Narrow security projection

The existing controller computes `PAPERCLIP_GIT_METADATA_ROOTS` from the admitted
workspace and overwrites user-provided values. Only the explicit Codex launch
passes it through the isolated environment boundary. The version-pinned Codex
ACP patch validates existing absolute real Git metadata roots and adds them
only to session/turn sandbox writable roots. It does not make them skill,
MCP, trusted-project discovery or general filesystem roots. Other harnesses,
ambient environment and configured arbitrary user projections remain denied.
No sandbox bypass, model permission escalation or network widening is used.

The installed Codex 0.160.0 dependency and all existing source patch behavior
(system prompt, approvals, skills, networking, goal publishing) are preserved.
The reconstructed npm `@agentclientprotocol/codex-acp@1.6.2` executable digest is
`sha256:149e29b605e7cf04a889280d005d541c92d4a8140472f9f93648c86cab9f1fb4`.
TypeScript, Rust, provider-pack and native-session qualification declarations
stay synchronized with these exact bytes. A matching declaration is not itself
a production qualification certificate.

## Verification and packaging

The patch was applied and syntax-checked against pristine npm package bytes in
a separate non-Git staging directory. Applying a package patch from a nested
project checkout can silently skip paths; the reconstructed executable digest
is verified, not assumed. Exact candidate package/network contracts passed
15 tests; sanitizer/sandbox boundary tests passed on the matching source.
`pnpm-lock.yaml` is intentionally unchanged because existing repository policy
makes lock regeneration CI-owned. A release builder must regenerate the patch
hash through the supported CI process and retain the resulting locked artifact;
manual lockfile exceptions and fake bot authors are not allowed.

## Bounded actual-worker test and rollout

Before global installation, a native task-scoped `agentCommand` override may
point only to this independently reviewed immutable candidate package while
preserving engine=acp, model, credentials, normal approvals and sandbox policy.
The actual worker must create/read/delete nonce files in its own worktree and
both controller-resolved Git metadata directories, and fail to write an unrelated
operator-prepared directory under the same OS user. Only that proof, not host
permissions or synthetic environment tests, can establish the original EROFS
repair. No Git commit/fetch/rebase/push or user file change is authorized by the
probe. Abort on unexpected paths or unrestricted sandbox behavior.

Global runtime deployment still requires independent source review, qualified
release/CI artifact, zero live runs, private rollback backup, installed source
and byte readback, health checks and current-state verification. Do not directly
patch the live package store or silently switch to a less-confined CLI engine.
