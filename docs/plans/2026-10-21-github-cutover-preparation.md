---
title: GitHub state continuity preparation and isolated rehearsal
created: 2026-10-21
status: preparation-candidate
---

# Preserve observation state before activating a replacement writer

This candidate is an executable preparation and review packet, not a production
migration facility. Its code lives under `packages/github-operations/test/`, is
excluded from the package build, and adds no action, Host route, manifest grant,
catalog entry or published package. All fixtures are synthetic. Installation,
activation, source export and real state import require their own exact authority.

The result to preserve is a continuing observer: the existing task and subject,
owner and thread, generation, original baseline and predicates, collected and
delivered frontiers, outcomes and their delivery receipts. Fresh registration is
not a migration: the archived failing stock-entry probe freezes a new baseline,
generation 1 and default continuation instead of retaining generation 27. The
normal registration implementation is correct for its own purpose and is unchanged.

## Required source cut

The operator must establish a complete, frozen source and absence of both writers.
The source digest detects changed bytes; it does not authenticate an export or
authorize new destinations. Unknown coverage is a refusal, never an empty family.
Current task owners and repository notification recipients require a separately
resolved routability witness. An unavailable current recipient blocks preparation;
an unavailable historical author is retained and does not become the new owner.

| Source | Destination or treatment |
| --- | --- |
| Existing PR/issue Task identity and complete fenced `automationState` | `github.typed-wait.v1.<sha256(taskId)>`, schemaVersion 1, unchanged Task; no normal registration call |
| Existing repo configuration | `community.repo.<sha256(repo)>`; retain policy, destination and original timestamps |
| `f141:baseline:<repo>` | `community.scan-baseline.<sha256(repo)>` |
| `f141:notified:<repo>#<kind>-<number>` | `community.scan-notified.<sha256(kind:repo#number)>` |
| `community:repo-comment:cursor:<repo>` | `community.comment-cursor.<sha256(repo)>`; preserve the timestamp, including the provider's deliberate overlap behavior |
| Old pending outcome/wake and transport claims/receipts | Reconcile against the authoritative old delivery ledger before transfer; this candidate refuses pending or unknown delivery |
| Provider event history, old dispatch receipts, terminal registrations | Retain immutable originals under their existing owner; historical metadata copy is not an active event replay or governance import |

The prototype deliberately covers only settled, already fenced waits and repo
progress. It does not translate legacy issue trackers without an `await`, migrate
pending outboxes, or claim to copy provider journals/transport receipts. A caller
asserting complete coverage must separately retain and verify those sources; that
assertion is not checked by this in-memory rehearsal. The current operator packet
must name every unknown or unsupported family and cannot be declared production ready.

## Actual consumer boundaries still required for production

`TypedWaitRuntime.poll()` requires both the installation-private record and the
Host Task's matching `pluginWait` projection. Copying private KV alone is silent.
The consumer test demonstrates zero reads without that projection and one new
fact delivered to the original thread/cat after a simulated Host acknowledgement,
using the old generation/baseline. The acknowledgement is a fixture, not an
implemented production import action.

An eventual module-owned import must use existing owner-scoped SDK Task and thread
ports, verify current bindings, and publish the matching Host wait projection with
generation/instance fences before releasing collection. It must neither create a
replacement Task nor overwrite a changed owner, subject, thread or generation.
The current ordinary action map has no such import/commit operation or import-only
activation hold. Those are explicit remaining implementation requirements. Do not
enable the stock module and then re-register waits to approximate this protocol.

Host and plugin delivery ledgers can have different scopes, even when the textual
idempotency key matches. An ambiguous old send must not be retried in a new plugin
instance namespace. Reconcile old append, broadcast and wake outcomes separately;
do not claim that a visible message proves its owner was woken. Pending deliveries
with no verified bridge block a cut rather than being discarded or sent twice.

## Staging, recovery and rollback

The preparation prototype validates every task and repository before constructing
the plan. It uses the existing repository-progress decoder and real private Task
reader, not a copied business implementation. A changed source digest, stale
binding, active writer, duplicate subject, invalid progress key or pending delivery
refuses the plan.

Staging writes only `github.cutover.rehearsal.<planDigest>.*` inert keys. A crash
leaves a retryable identical prefix; conflicting payloads are refused. Current
Task/repo readers see none of these rows. An abort fences later completion and
retains inert evidence. Materialization allocates fresh memory internally, so the
prototype cannot be pointed at production storage. It never calls a provider,
publishes a Host projection, sends a message or starts a schedule.

Before a production commit, rollback means keep both writers paused and preserve
the original source and inert stage. After any real new delivery or cursor move,
blindly restoring the old snapshot is unsafe: pause the replacement, export its
new frontiers and receipts, reconcile their ownership, and roll forward or obtain
a separately verified reverse transition. No deletion or full historical replay
is a rollback mechanism.

## Proposed authorized execution order

1. Resolve the current cutover owner and exact source-export, install and grant
   authority. Freeze a content-addressed source with complete counts and receipts.
2. Verify the retired writer is absent; acquire a bounded replacement hold before
   any activation/recovery/schedule can run. The stock package lacks this hold.
3. Verify the selected package bytes/provenance and the Host policy versus its
   requested capabilities. A catalog miss is not authority to publish a new row.
4. Preview every mapping and recheck original owner/thread/subject/version. Reject
   unresolved old issues, pending receipts or changed bindings without writes.
5. Stage and verify all module state; use a reviewed owner operation to publish
   fenced Host projections. Recovery must finish that same import generation and
   respect cancellations or owner changes, not start a fresh registration.
6. Release exactly one writer only after the full import and projections agree.
   Observe the module's five schedule contributions and natural progress, then a
   subsequent complete idempotent cycle and source-bound owner delivery.
7. Preserve original state/receipts/history and the cutover receipt. Closing the
   recovery requires actual runtime acceptance, not this prototype or package publication.

## Reproduction

From this repository's worktree:

```sh
env -u NODE_ENV pnpm install --frozen-lockfile --ignore-scripts --filter @clowder-ai/github-operations...
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/plugin-sdk build
pnpm --filter @clowder-ai/github-operations typecheck
node --import tsx --test packages/github-operations/test/cutover-preparation.test.ts
```

The negative stock-registration probe is archived as text in
`docs/evidence/github-cutover-preparation/stock-registration-repro.ts.txt` so an
intentionally failing diagnostic is not added to the ordinary test suite. Its
original assertion and actual/expected diff are retained. The passing rehearsal
does not redefine normal registration or assert any production migration happened.

Architecture cell: github-operations. Map delta: none in production. Why: this is
a test-only preparation candidate; current private storage, SDK Task projection,
registration and delivery authority remain unchanged. Consumer evidence is the
real `GitHubWaitStorage`, repository progress decoder, `SdkCommunityRepoConfigStore`
and `TypedWaitRuntime` driven by the tests. Claim guard: a lost baseline, changed
binding, unprojected wait, ambiguous receipt or resumed aborted stage fails the
corresponding executable fixture.
