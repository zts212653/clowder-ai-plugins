---
title: Terminal pull request provider facts and bounded historical reconciliation
created: 2026-11-06
status: author-verified-awaiting-re-review
---

Merged and closed PR snapshots previously discarded final HEAD, review commit association and merge/CI provenance on the way into the Community journal. Terminal CI was an unconditional pending placeholder. Retrying a native verdict correctly refused the terminal subject, so that retry could not repair the lost provider facts.

The implementation preserves final provider facts in a `pr.terminal_observed` journal event and its optional rebuildable `terminalFacts` projection. The existing subject/repository inspection surfaces use that final HEAD and source-bound CI. A review belongs to the final HEAD only when its explicit commit matches. Unbound reviews remain uncertain historical evidence. Empty rollups and cancelled-only terminal checks are unknown, rather than a fabricated pass or running CI. Original check status/conclusion and links remain inspectable.

The aggregate's provider HEAD/CI fields also advance so the existing board and status chips display the final facts. Its assignment, last reviewed/delivered HEAD and delivery history do not come from GitHub approvals. A final provider fact fences queued open-subject observations and assignments as well. The fix uses the current journal, projector, collector and reconciler owners; it adds no backfill store, service, queue or polling lane. Existing large composition roots remain in place because splitting their unrelated state-machine, webhook and lifecycle logic would expand this fix's locking and replay surface. Fact normalization and reconciliation authority live in separate modules.

Independent producers may append in one order and call the projector in another. Projection now folds the committed journal prefix in insertion order. Its cursor counts all consumed positions, including rejected events, and is saved in the same storage write as each state mutation. A legitimate native verdict committed before closure therefore remains present in both the live projection and rebuild. Interrupted writes resume from that cursor. Legacy cursorless projections replay once, retaining cross-subject issue links and their existing merge cascade. Ordinary updates read only the new journal tail.

## Supported historical entry

`github_reconcile_terminal_pr({subjectKey: "pr:owner/repository#12"})` dispatches to `github.subject.reconcile-terminal` with the Host's authenticated native context. It accepts one existing terminal PR and requires its repository to remain configured. It re-reads the provider under an invocation, configuration and shutdown fence, validates subject/HEAD/CI identities, and appends only a provider observation. Supplied facts or authority fields are refused. An existing terminal subject is never registered for tracking, leased or woken by this action.

One provider snapshot has one deterministic event identity. Separate observations retain their times, so real same-HEAD CI changes are representable. The merge preserves sparse fields and orders CI using the CI observation's own time. A newer complete unknown/empty result supersedes an old pass, while a later sparse webhook with `ci: null` cannot erase that result. Dismissed reviews remain dismissed. Terminal identity conflicts are never projected as a new final HEAD.

Webhook, single/batch tracking and repository reconciliation converge on the same fact event. Automatic collection admits live terminal transitions and refreshes enrolled facts, but cannot enroll legacy terminal subjects missing facts, including tracking retries and webhook redeliveries. The explicit native action performs that enrollment. Owner-authored terminal webhooks retain the no-intake-notification policy. Reconciler first-run baselines stay quiet. Enrolled terminal subjects continue complete provider reads on the existing reconciliation cadence after pass/fail, so subsequent CI changes remain visible; this adds provider-read cost within that lane. Unenrolled legacy subjects use summary reads only.

## RED and source validation

Seven initial behavior assertions failed for the intended reasons: the real Community runtime retained an old HEAD, both exact and batched terminal provider reads returned pending despite a successful rollup, and a foreign subject was accepted. These were observed before implementation, rather than inferred from a probe's output. The subsequent tests invoke production entrypoints and journal/projection owners.

Final package validation:

- `pnpm --filter @clowder-ai/github-operations typecheck`: exit 0.
- `pnpm --filter @clowder-ai/github-operations build`: exit 0.
- `pnpm --filter @clowder-ai/github-operations test`: **828/828**, zero failures or skips.
- `git diff --check`: exit 0.

Coverage includes same-batch final HEAD/review/merge, closed without merge, explicitly reconciled terminal history, sparse/concurrent/out-of-order observations, CI rerun ordering, stable rebuild, wrong subject/commit/review parent, incomplete and paginated CI, unknown CI, caller/configuration revocation and shutdown. Existing review dismissal, notification and tracking tests also pass.

Independent review found three additional failures: reversed append/apply order lost an earlier native verdict, scheduling automatically enrolled historical subjects, and a later CI failure/unknown could remain an old pass. All three were reproduced before their fixes. Regression coverage uses independent projectors, interruptions before/after state saves, the real scheduled runtime, and complete unknown versus sparse webhook input. The same authorization failure was also reproduced and fixed at tracking retry and signed webhook entrypoints. Cursor adoption separately exposed a cross-subject link regression, which was reproduced and fixed. Existing tests that directly saved unjournaled derived state were changed to seed real journal events, preserving their original authority and concurrency assertions.

## Installed consumer

The repository's `scripts/pack-publish-artifact.mjs` produced an unpublished archive. A new directory installed it with ordinary npm and its registry-pinned dependencies, without workspace dependency overrides or symlinks. The installed package's SDK is `0.3.0-beta.2-candidate.11`.
All 767 published package files were compared byte-for-byte against the source build and package inputs.

The paired test runs the complete installed factory and SDK through an actual Host worker and native invocation/storage facades. Its Redis child uses a private Unix socket (`--port 0`); it never discovers a running Host, uses inherited Redis URLs or connects to production data. The explicit compatible Host checkout was `5628446293b1c5b341d2764c4b03b7d00695d402`. The ordinary main checkout's old `dist` lacked the required indexed capability, so that initial environment failure is not represented as a candidate failure or a green result.

The candidate provider independently read the final public PR snapshot, including its matching review commit and 20 actual CI contexts (19 success, 1 skipped). Feeding that snapshot into the installed worker's isolated historical case passed **1/1**, zero skips:

- Native verdict submission still returned `409 subject_terminal`; its real persisted `not_recorded` diagnostic remained byte-for-byte unchanged after repair.
- The final HEAD/review/merge/CI facts were returned by the supported native repair and subject inspection actions.
- Original native delivered HEAD/reviewer history and the done generation-5 subscription remained unchanged; no notifications or wakes were sent.
- Worker restart plus an identical repair exercised the duplicate/rebuild path, with identical inspection readback and no extra business event.
- Two scheduled reconciliations before explicit repair left the historical subject unenrolled. After repair, controlled provider CI pass → fail → unknown observations flowed through the actual installed scheduled action. Restart/rebuild plus the older original snapshot retained unknown. These later CI changes are isolated fixtures, not claims about the public PR changing.

Reproduce with explicit roots after installing a freshly packed candidate:

```sh
CLOWDER_GITHUB_TERMINAL_HOST_ROOT=/absolute/compatible-host \
CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT=/absolute/fresh-consumer/node_modules/@clowder-ai/github-operations \
node --test packages/github-operations/test/host-terminal-facts.mjs
```

Optional `CLOWDER_GITHUB_TERMINAL_SNAPSHOT` supplies a private provider-captured snapshot for isolated acceptance. Without it the test uses public synthetic data. Captured provider bodies, credentials, private thread evidence and raw logs are not committed.

Candidate archive SHA256:

`837c1d853f4a08ce2d6271a38ba3d1b6887e61dc954800ef0bfbf6bbfc5261da`

This archive still carries the source version `0.1.0-alpha.37`; it is an unpublished review candidate, not the immutable published alpha.37 package. Exact archive identity distinguishes it. A separately authorized release must allocate the new version and align its release/catalog metadata before publication; the old published version must never be overwritten. The full release/catalog gate is not claimed here.

## Delivery boundary

Source repair and isolated candidate validation do not prove a production historical repair. Independent review is still required. This work does not merge a publishing branch, publish npm packages, activate catalogs, upgrade a running installation or mutate a real historical subject. The installed version and original production view therefore remain unchanged until those separately authorized steps are performed and read back.
