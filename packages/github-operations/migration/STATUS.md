---
feature_ids: [F202]
topics: [github-operations, c1-migration]
doc_kind: implementation-status
created: 2026-10-08
---

# W3 migration — package candidate verified, Host acceptance pending

## Current source and artifact checkpoint

The current accepted migration source is Host main
`bb9f9f08ec574ee8888fbde9819ff95da96bb614`, under operator source
`thread_mu8dg6h7l2x4ohsk#0001791597354169-000043-8e6a39d2` and task
`0001791444624720-000204-90f02d10`. The historical rulings below describe earlier
checkpoints; they do not override this source or the current implementation.

Package source `5789dfa690e81735a5692923989b08346597a022` has an independently
approved alpha.16 dependency closure (Codex verdict
`0001791616947638-000088-9bd47bb9`). Its five-stage package gate passed 610/610
tests with 440 committed source hashes. Contract beta.35 and SDK beta.19 are
the reviewed local bytes; their registry coordinates do not imply publication.
The self-contained archive has 5422 members, 136 installed dependency packages
and no symlinks. Relocation, module startup, embedded HTTP create/read/restart,
native/owner entry separation and stop were exercised with isolated Host ports.
These are package checks, not a real Host installation or browser acceptance.

The production module now includes the 33 Community HTTP method/path pairs,
six native Community callbacks, native review-verdict submission, private
freshness/completion verifiers and manual narrator delivery recovery. Native
review intent is persisted before custody completion; background retries cannot
borrow a stored principal. Exact success replay reauthorizes but cannot replace
the first canonical verdict. CI batch adaptation from source `4f2b5644` is
consumed by the real typed-wait poll, with per-PR cancellation/deadlines.

Publisher association is explicitly **unavailable**. GitHub account identity,
URL, review body and current HEAD do not prove which cat published an object.
Completion therefore returns `insufficient:publisher_association_unavailable`
and retains the pending submission. The paired Host contract requires this
honest refusal when trusted evidence is missing; no successful live review
settlement is claimed. Adding a publication-authority mechanism is not a silent
substitute for migrating the existing source.

Only manual narrator dispatch was wired in the fixed source. The copied automatic
eligibility helper had no production caller; preserving it does not authorize
new automatic wakes. Host identity/grant/lifecycle checks, source-link Redis CAS,
actual installation and browser journeys remain separate acceptance work.

## Historical operator180 composition

The current source uses native tracking MCP → authenticated SDK action → the
same active module. All typed predicates, baselines, renewal and outbox state
live in this package. The SDK delegates neutral `tasks.setWait`; the runtime
persists that projection before sending and repairs delivery state after restart.
Five schedules replace the previous three independent PR loops plus issue and
repository polling. Tests now use the original typed-wait semantics: identical
terminal CI fingerprints do not wake twice, and expiry requires an explicit
deadline. The old simple tracker remains historical source, not an active worker.

Local install, real Host continuation consumption and old caller deletion are
still pending. npm/remote distribution and soak are separate later work. No
historical source gate or archived artifact proves this new composition.

## Historical checkpoint

Authority: task 0001791444624720-000204-90f02d10, source thread
thread_mrkn6povq4zzgh45. Scope corrections 243 and 256 take precedence over
the initial mechanical copy of Host orchestration. Source is frozen at Host
496e24089ffb5f99fa241e04c7ee0850df227be4; package baseline is
80e26fc4bc2c337449c80e3f32184db1a96f07cf. Commit 6636763 records the untouched
93-file source copy so later business and boundary differences remain reviewable.

The enabled builtin owns its lifetime, registrations, cursors and terminal
unregistration. It uses existing SDK storage, thread bindings and messaging with
optional wake. No tracking or configured repository means no GitHub requests.
Stop aborts provider work and waits for cleanup. No new SDK action context, wait
framework, caller protocol, task automation state or Host private imports are
part of the intended runtime.

## Historical evidence (superseded where the current checkpoint differs)

- Real manifest and SDK carrier tests cover tracking registration, filtering,
  durable pending delivery, restart, terminal notification and stop cleanup.
- Seven schedule methods are wired. Repository registration, initial baseline,
  scan dedup, comment collection and reconciliation run within the same builtin.
- Community event log, projections, repository configuration and findings use
  private SDK storage. Events are persistent; a bounded append reservation
  recovers interrupted materialization. No Host Redis migration is executed.
- Twelve frozen source test files (181 tests) are copied with import-edge changes
  only; provenance is in test-source-map.json. Whole-package clean build and
  260/260 tests pass at this checkpoint, including provider projection, CI
  rerun/delivery, review pacing, bounded polling, cleanup and batched CI. The
  changed behaviors have individual RED/GREEN evidence; this is not full parity.
- Whole-package source and test typechecks pass. Source hashes/declaration
  provenance are in source-map.json and shared-model-map.json. Superseded Host
  orchestration copies were removed with per-file replacement dispositions,
  never hidden with typecheck exclusions. Compilation is not parity acceptance.
- Boundary ruling 286 retains typed external-review verdict submission in Host.
  Package observations now reach the private HEAD/CI projection through the real
  SDK builtin, while ordinary notifications use SDK messaging. There is no
  package verdict, lease, admission or callback-principal action.
- The shared repository/CI gate now runs GitHub source/test typechecks, clean
  build, tests and lint explicitly. The frozen machine inventory remains in its
  pending checkpoint; implementationProgress records actual implementation
  evidence separately, preserving the existing single catalog exception.
- The previous clean checkpoint `28a38cb` passed all 29 repository gate steps
  in 276.249 seconds with unchanged HEAD and clean worktree. New source changes
  have separate targeted/typecheck/build/package evidence; that old gate is not
  claimed for this new tree.
- Ruling338 removes the copied assignment-writing TriageOrchestrator. Pure triage
  recommendations are available through a declared generic tool and do not
  authenticate observations or mutate governance. Private issue metadata refuses
  governance fields. Repository polling uses bounded reads, awaited cleanup and
  persistent fairness; reconciliation baselines successful subjects independently.
- Cloud classification now uses complete provider facts and explicit request
  correlation, without Host wait state. Timeout messages use the existing outbox.
  Three real carrier projection-failure cases and reconciler recovery are covered;
  failed projection cannot be silently retired by delivery/scan dedup.
- Ruling404: new installation-private drafts are reachable through generic tools;
  publication is an owner-local declared operation with explicit confirmation.
  Sanitization, repository allowlist and a durable publication-attempt journal
  precede the single gh POST. Restart only reconciles the original exact marker,
  authenticated GitHub author and content; uncertain results never repeat POST.
  Storage-failure recovery, concurrent carriers, cancellation, corrupt outcome
  identity and awaited stop are tested with isolated providers, not real GitHub.
  The legacy userId/confirmed draft pipeline is removed from the package copy
  and retained in Host. Its old GET/cancel/publish/from-frustration paths are not
  covered by native draft verification or authorized for deletion.
- Repository observations expose bounded pages of provider-only journal facts,
  including webhook-only subjects. They do not replace Host governance boards.

## Historical implementation and verification queue

Current additional evidence: the owner-confirmed legacy issue metadata operation
validates bounded raw snapshots before insert-only CAS. Concurrent imports,
partial failure, restart and preservation of owner edits are verified. Governance
fields are excluded; the Host export adapter remains pending.

Emitted-module dependency inspection first found six undeclared `zod` imports
in unused legacy wait/schema copies. The current package now retains seven
shared declaration files (37 exports, 55 exact frozen-source statements), with
omitted legacy roots recorded in shared-model-map.json. Old wait baseline/
predicate producers and superseded Redis/in-memory adapters are excluded from
the package; their Host counterparts and data remain untouched. Every emitted
module is checked against declared production dependencies, including files not
reachable from the entrypoint. This check is not a fresh-consumer installation.

Ruling463 separates bounded provider briefings through ordinary SDK messaging
from Host role bindings and authenticated callbacks. Those copied consumers and
automatic rebase/push are absent from the package; Host consumers remain intact.
Static comparison verifies 13 byte-identical runtime files and nine with only
type-import path changes. This is not full parity for all 96 source entries.

Integration order478 reserves SDK beta.13 and seven connector alpha.3 candidates
to Sol/task296. W3 consumes that exact candidate before GitHub alpha.1 package,
shrinkwrap and fresh-consumer closure; no second SDK identity is generated here.

1. Complete the Community business comparison and legacy-state disposition;
   native draft/read-model carrier tests do not prove full old-route replacement.
2. Complete per-file business comparison. Remove superseded copied Host
   orchestration only after accounting for its business behavior. Old wait/
   custody producers are retirement candidates, not a new plugin prerequisite.
3. Complete notification/event convergence, fairness/failure/cancellation tests,
   validated inputs and corrupted-state tests across the full runtime.
4. Final whole-package typecheck/build/test, fresh-consumer, deterministic canonical
   packaging, catalog/version/pins, full repository gate and independent review.
5. Host consumes the complete candidate and proves no double-run before deleting
   old GitHub producers/consumers. Preserve deployment/hold-ball common guards.

## Installation acceptance matrix

| Source | Package evidence | Host install → enable → run evidence |
| --- | --- | --- |
| npm | Canonical alpha.16 bytes built; dependency registry publication not claimed | Pending Host consumption |
| Local directory | Clean built package at approved source `5789dfa` | Pending real Host consumption |
| Fixed Git repository/revision | Approved local source `5789dfa`; no remote push claimed | Pending real Host consumption |
| Canonical/self-contained archive | Physical closure independently verified; SHA256 below | Does not substitute for any row above |

Canonical alpha.16 SHA256:
`06367cc7cc3928bc983565514dc6245cff07815f1ce2a03b6666eb30c99fa0ee`.
Self-contained darwin/arm64 SHA256:
`5313a41f29c1fae30f40783abbd42c157b2cc06c5fa5f14a12faf112d1bf9b50`.
Local handoff evidence: `f202-handoff/w3-github/alpha16-closure-r1/committed.json`
and `f202-handoff/w3-github/alpha16-packed-r4/artifact-descriptor.json` under the
shared github-lab workspace. Later documentation-only commits do not change
these archive bytes; implementation changes require a new candidate.

Full C1 acceptance also requires generic bidirectional Host interfaces, business
inside the SDK-consuming package, generic MCP/skill registration, and complete
package YAML/configuration/capability declarations. Passing a partial runtime or
an official release archive proves none of the missing installation sources.

No Host worktree writes, old-state deletion, release, npm publication, PR merge,
operator HOME mutation or production instance restart occurred in this work.
