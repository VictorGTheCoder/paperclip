# TFT installed-runtime archive repair

## Source identity and scope

The live npm-managed Paperclip 2026.1012.0 install is a local reviewed release
from source commit `82eef2bca238c3f9362e965b20a8b030244e8f41`, not the newer
canonical checkout `08563be8...`. Its pre-change server archive route/service
compiled JavaScript hashes were compared against the matching source build and
are identical. This patch is based on that actual installed release; it does
not upgrade unrelated product code, alter schema or migrate user data.

Previous draft runtime PR #8 investigated the correct failure class on a newer
source tree. Its native-finalization table and `heartbeat_runs.issue_id` column
do not exist in the installed release, so applying that source unchanged would
fail. This backport uses durable heartbeat context/nativeIssueId and linked
workspace operation records available in the installed schema.

## Fix and verification

Task `done` and a cleared transient issue run pointer do not prove that the
legacy ACP callback stopped using its worktree. Native close-readiness now
blocks queued/running linked runs and uncompleted enclosing finalizers. It
requires successful validation after the latest checkout preparation, compares
terminal operations by completion time, includes descendants, and rechecks
inside the existing lifecycle-lock transaction in manual and automatic archive.
The route returns HTTP 409 before destructive cleanup. Existing shared/dirty
worktree, reopen/generation, company and Git-delivery checks remain intact.

The complete archive route/service suites pass **85 tests** on the matching
release dependencies and embedded PostgreSQL. Tests include actual legacy ACP
race, nested success vs outer finalizer, later preparation invalidating old
validation, retries, and ownerless callback fail-closed behavior. No liveness
proof is invented: abandoned operations need an audited recovery disposition.

## CI reproducibility

The old PR wrapper calls mutable upstream `master`, which now expects source
files absent from this release. Pin the same full trusted workflow at the exact
reviewed installed-source commit in this fork. The checked-in trusted workflow
itself is unmodified. Its original upstream release commit `bba6a45f0d364cfd962ac59b3bdf2426a8222adb`
contains the identical workflow bytes (Git blob `b87e5115b9cfbf616fd26784dd0a7430002d9ece`);
the caller pins that upstream immutable release rather than the mutable master. The pin regression preserves aggregate verification and
end-to-end gates. No tests, branch protections or reviewer requirements are
removed or changed to `continue-on-error`.

## Rollout and recovery

Before live changes: independent exact-head review, relevant CI, complete local
component suite, package/source hash verification, private backup and zero
live/queued Paperclip executions. Stage a separate candidate install, retain the
current release target and database backup, and promote via the existing managed
install/symlink mechanism only with a rollback receipt. Verify API health and an
actual worktree-finalization/archival probe before enabling cleanup. The automatic
cleanup timer remains disabled until that runtime evidence exists. Never directly
edit the original dirty canonical source or production database to fake success.
