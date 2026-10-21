---
title: GitHub consumer continuity through supported module recovery
created: 2026-10-21
status: implementation-candidate
---

# Resume existing GitHub observation without replacing its baseline

Before: retired observers retain progress but their replacement has no active
consumer. Re-registering silently substitutes a fresh baseline. After: the owner
reviews a bounded frozen source, imports under a durable collection hold, obtains
current original-owner Host bindings, and releases one collector. Installation,
persistent grants and real source export retain their separate operator authority.

The first PR96 revision was a test-only preparation. This continuation adds real
module code and declared owner HTTP/Settings/native entries; its earlier review
covers only the earlier revision. This candidate requires a new exact-HEAD review.

## Source and authority

`freezeGitHubSource` takes only read-only ports, compares two bounded cuts with the
old writer absent, and rejects unknown families or drift. `migration-source-cli`
provides a real file producer for an already authorized GitHub-only source export.
It rejects unrelated top-level families, oversized/non-regular/symlink input,
keeps the input unchanged, writes a new 0600 file exclusively, and prints counts
and digest only. Hashing proves consistency, not origin, grant or completeness.

The actual generic Host Task projection omits `automationState` and hidden
`typedWaitRegistration`. The owner source-coverage entry reports that gap instead
of manufacturing a complete export. The remaining operator backend must provide:

- full selected live/unsettled GitHub tracking state and original identity/version;
- original repo configuration, baseline/notified membership and comment cursor;
- exact already-seen comment IDs in the cursor's overlap, without provider bodies;
- pending append/wake claims and conclusive source receipts, scoped to those tasks/repos;
- opaque original registration/history retention references, never copied grants.

Read those from the original authorized operational adapters or an approved
immutable GitHub-only export. There is no new Host business route, Redis access,
chat/secret export or full-store dump. Current SDK reads alone cannot produce it.
The source inspector and file producer are executable; a live legacy exporter is
still a precise prerequisite, not a capability this module claims to own.

## Ordinary owner journey

Set `recoveryMode` to `import-only` before activation. The mode is frozen for that
activation; changing it requires a fresh controlled activation. Hold pauses all
ordinary actions, five schedules, webhooks, registration and outcome recovery.
The Settings recovery panel exposes authenticated status and source coverage.

Declared non-anonymous owner HTTP contributions use `github/migration/{status,
source,stage,commit,recover,abort,release}` (GET for the first two, POST otherwise).
They accept only the Host-authenticated owner context, not an input principal or
native caller as substitute. Stage takes `{ snapshot, expectedDigest }`; subsequent
operations take the returned plan digest as `expectedDigest`.

1. Stage validates the whole source and every current binding/routable destination
   before the first insert-only inert row. Source/owner/version drift, duplicate
   subjects, active targets and ambiguous receipts refuse the batch.
2. Commit copies exact private records while the hold remains active. Partial
   responses/crashes resume the same records and reject conflicts. It reports
   any live typed waits still requiring their original Host binding.
3. From each original current cat/thread, the installed native
   `github_bind_migrated_wait` confirms that Task ID/plan digest. It requires strict
   owner provenance and preserves the original generation/baseline. The generic
   Host first-wait port requires a real original-cat invocation; owner HTTP cannot
   impersonate it. A fresh binding intent/ack records this new authorization and
   recovers a lost reply without copying old registration authority or rearming.
4. Owner recover verifies the complete import and all current Host projections.
   Release checks them again before opening the single writer. Pending outcomes
   are recovered only after release, using the original outcome ID/fence.
5. A stage interruption is idempotently retryable. Abort is allowed before active
   copy; it fences late completion and keeps inert evidence. An explicit new
   frozen cut may start a new import epoch in the same installation, preserving
   the aborted journal. Once copy/binding begins, rollback is forward recovery
   under hold; it does not erase Host state or restore a stale source snapshot.

## State preservation and receipts

Typed waits retain Task ID, subject, user, cat, thread, historical author,
generation, baseline, predicates, expiry, renewal and collector frontiers.
Expired waits remain inert history with their original identity/generation; they
do not acquire a route, wake or new deadline and do not block live valid rows.
Legacy owner-readable historical Tasks may retain a null persisted user binding;
active observation requires a verified user. No owner is silently rewritten.

A legacy issue without await continues its original dual cursor through a dedicated
observer, never a fabricated typed generation or fresh provider baseline. New
comments use a durable same-instance outbox; unknown sends retry the same key.
New source facts retain original GitHub IDs and go to the original current owner.

Pending old outcomes require an exact source receipt. Conclusive append+wake
success marks delivered; conclusive no-append/no-wake permits that same matched
outcome after a fresh native binding. Partial/ambiguous old sends stay at source.
A pending legacy wake requires the exact original message receipt and destination;
an unfinished terminal-close obligation must be settled at source. It cannot be
sent again in a new instance namespace. Repository pending claims must be settled before importing.
Only overlap seen IDs become dedup fences; no fake event history/body is appended.

## Scope, permissions and verification

No source/current policy/grant, catalog or package publication is changed.
The production consumer closure has no thread timeline read; remove the unused
`thread.readContent` request. The manifest now requests ten capabilities; the
existing official Host policy allows eight, leaving exactly `task.read` and
`task.write` for separate final authorization. Generic Task access stays owner
scoped; import uses read/get and exact wait CAS, not Work/lease ownership changes.

Executable checks use ordinary module activation and owner/native actions:
hold, cross-user/refused spoofing, original g27 binding, expired g1 history,
legacy issue progress, source drift, receipt ambiguity, prefix/active-copy/lost
binding response recovery, abort, revocation and release-time binding changes.
Fresh-consumer evidence must use the final packed bytes without workspace links.
Actual production installation/grants/source export/natural ticks remain separate
unperformed conditions. A code or package pass is not recovery completion.

Architecture cell: github-operations. Map delta: module-owned recovery and legacy
issue continuation inside the existing cell. No Host GitHub API, second publisher
or new business authority is added. Review focus: source completeness, original
identity, CAS/recovery, cross-namespace delivery and import/release boundaries.

## Original notification route and guard assignment

The actual legacy repo scanner sends through `ConnectorThreadBinding.threadId`;
it resolves the recipient cat separately from `CommunityRepoConfig.guardCatId`.
`guardThreadId` is a community guard assignment and may legitimately differ.
The production read stopped at this difference without writing a source snapshot.
Do not make the two fields equal or infer that either original record is corrupt.

The same repair branch now carries `notificationRoute` separately in the frozen
repository row. Both destinations must be owner-readable, the route owner must
equal the source owner, and both recipient checks run before staging. Imported
private config retains the guard assignment and stores `notificationThreadId`
for scan/webhook delivery. Ordinary policy changes preserve that route; an
explicit guard-thread change replaces the notification destination as before.
Old notified/cursor state still suppresses old facts.

The alpha.19 bytes are an unadopted correction to this same migration, not a
second consumer. The approved alpha.18 archive `88e0f1ca...` remains immutable.
No production source write, installation, enablement, publication, or adoption
authority is implied by source review or isolated tests. The final exact archive
identity must return to the original Task117 owner before any replacement use.
