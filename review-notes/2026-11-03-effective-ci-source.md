---
title: Effective CI selection for repeated workflow runs at one PR HEAD
created: 2026-11-03
doc_kind: review
status: source-only-draft
---

# Problem and result

PR zts212653/clowder-ai#1784 at `7733392245566f9374519414d39f160d6b1dc725`
has a 34-context rollup. New successful CI, Windows and macOS runs coexist with
cancelled older runs. One older `Test (Public)` summary job failed before its
workflow was cancelled; its corresponding newer check succeeded. The old single
and batch readers aggregate that obsolete failure. Single-reader details even
show no failure while the aggregate remains failed.

Both readers now obtain identity-bearing GraphQL contexts and apply one selector
before calculating the aggregate and details. Only the same app ID, workflow ID,
check name and HEAD can participate in replacement. A greater workflow run number,
or a greater attempt within the same run ID, replaces its predecessor. Unverified
identity, unmatched jobs, separate apps/workflows and legacy status contexts stay
independent. Display names and URLs do not establish producer identity.

Same-run/same-attempt name collisions remain independent, even with different
check IDs. `WorkflowRun.runAttempt` is current suite metadata; a larger check ID
alone does not prove that a same-name job was superseded. This intentionally
retains ambiguous failures rather than manufacturing success.

The exact reader paginates locally and rejects cursor gaps/repetition, null rows,
partial GraphQL errors and HEAD drift. The shared batch still performs one query
and defers incomplete PRs to their own work item. Empty rollups stay pending.
Required-failure diagnostics can narrow only to checks whose canonical links,
names and buckets match; stale or unrelated details cannot replace selected facts.
Existing zero-step billing classification and cancellation semantics remain.

# Evidence

`packages/github-operations/test/fixtures/ci-pr1784-773.json` contains the public
34-context sample and its canonical GraphQL identity enrichment. Links and
conclusions were compared against the original archived rollup before use. The
permanent regression calls the production single/batch/provider entry points.

The regression was observed RED before implementation (`fail` versus expected
`pass`), then GREEN. Negative controls cover a new pending/failing run, independent
app/workflow, a different HEAD, missing identity/replacement, same-attempt name
collisions, legacy status failure, stale required details, pagination and partial
inputs. Existing transport tests retain cancellation, credential refresh,
per-PR deadlines and shared-batch isolation.

Author checks:

- GitHub Operations build and typecheck: exit 0.
- Full GitHub Operations package tests: 752 passed, 0 failed after sequential build.
- Fresh source-only tarball installed in a separate consumer, with lifecycle
  scripts disabled. Actual GitHub reads at the same `7733392` HEAD: single and
  batch each return `pass`, 21 selected checks, no failures and no warnings.
- Actual installed alpha.31 coordinator, projection reducer and verdict service
  were imported with memory-only dependencies. The candidate's live `pass` poll
  yields `ready_for_notification`; the assigned reviewer's `loadAggregate` accepts
  HEAD/generation 7. Pending remains pending verification, fail is rejected with
  `head_not_ready`, and wrong-principal/stale-HEAD controls still reject.
- Online event/projection writes, native calls and public review submissions: 0.

One intermediate package test run overlapped a build that cleaned `dist`; its
artifact-access failures were retained and the run was repeated sequentially.
Private raw logs, original RED, canonical pack metadata, install and readiness
probes remain with the source task's evidence, available to the local reviewer.

# Risk and release boundary

Architecture cell: `github-signals`; map delta: none. `community-ops` consumes the
same existing CI contract. Behavior risk is CI evidence selection; no persistent
schema, authorization, reviewer assignment, native verdict or policy changes.
Validation is the affected package, public real-world sample, fresh package
consumer and one non-author local review. Repository-wide gate status is tracked
separately; targeted success is not a claim that publication gates passed.

This is a source-only Draft, not a publishable version or an online repair.
Package/manifest/shrinkwrap/catalog/release-plan coordinates are unchanged. A
locally packed file inherits the alpha.31 manifest but has unpublished bytes;
it must never be uploaded as another alpha.31 artifact. Immutable/catalog checks
must remain honest until a separately authorized assembly selects a free version,
packs the actual dependency closure and records its release plan.

PR191 owns its alpha.33 diagnostic change independently. This change neither
rebases that WIP nor combines publication plans. No main merge, npm publication,
catalog activation, official upgrade, runtime restart, subscription rebuild or
public review retry is authorized here. Collector cursor/commentsComplete and
historical 502 attribution remain outside this repair.
