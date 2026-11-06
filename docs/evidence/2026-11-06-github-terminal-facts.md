---
title: Terminal pull request provider facts and bounded historical reconciliation
created: 2026-11-06
status: author-verified-awaiting-re-review
---

Merged and closed PR snapshots previously discarded final HEAD, review commit association and merge/CI provenance on the way into the Community journal. Terminal CI was an unconditional pending placeholder. Retrying a native verdict correctly refused the terminal subject, so that retry could not repair the lost provider facts.

The implementation preserves final provider facts in a `pr.terminal_observed` journal event and its optional rebuildable `terminalFacts` projection. The existing subject/repository inspection surfaces use that final HEAD and source-bound CI. A review belongs to the final HEAD only when its explicit commit matches. Unbound reviews remain uncertain historical evidence. Empty rollups and cancelled-only terminal checks are unknown, rather than a fabricated pass or running CI. Original check status/conclusion and links remain inspectable.

The aggregate's provider HEAD/CI fields also advance so the existing board and status chips display the final facts. Its assignment, last reviewed/delivered HEAD and delivery history do not come from GitHub approvals. Canonical native terminal history also fences queued open-subject observations and assignments, even while the provider PR remains open. A provider reopening never revokes that native fence. The fix uses the current journal, projector, collector and reconciler owners; it adds no standalone backfill store, service, worker or polling lane. The existing large projector keeps its state-machine, native review aggregate, cursor and unfinished operations under one subject fence. Splitting those intertwined transitions would enlarge the ordering boundary. Collection/checkpoint logic, fact normalization and native reconciliation authority are separate modules.

Independent producers may append in one order and call the projector in another. Projection folds the committed journal prefix in insertion order. Its cursor counts all consumed positions, including rejected events, and is saved in the same storage write as each state mutation and its pending existing cross-subject operations. A legitimate native verdict committed before closure therefore remains present in both the live projection and rebuild. Interrupted operations resume from their durable source reference, outside the subject lock. Duplicate child events are idempotent; reciprocal operations do not hold each other's subject locks. Ordinary updates read only the new journal tail.

Cross-subject bootstrap associations enter the PR journal as `pr.issue_linked` with a verified source issue/bootstrap reference. PR replay starts from its journal rather than the final cache's link set. A link discovered later cannot create a cascade attributed to an older merge. The former rebuild-all pass that used final links against old merges is removed. Legacy associations can be recovered from proven issue bootstrap sources at the current PR journal tail. Derived cascades cannot reopen reported, closed or declined issues.

## Supported historical entry

`github_reconcile_terminal_pr({subjectKey: "pr:owner/repository#12"})` dispatches to `github.subject.reconcile-terminal` with the Host's authenticated native context. It accepts one existing terminal PR and requires its repository to remain configured. It re-reads the provider under an invocation, configuration and shutdown fence, validates subject/HEAD/CI identities, and appends only a provider observation. Supplied facts or authority fields are refused. An existing terminal subject is never registered for tracking, leased or woken by this action.

This action uses projection-only replay: it stages the same projector logic privately and saves one complete replacement. It preserves current associations and unfinished original operations. Already committed but not yet projected original workflow operations remain pending for their original owner; the repair does not execute them or create historical association/cascade events. An interrupted replay cannot erase their records by deleting the live object.

Real content transitions retain their times and previous-source identity, so same-HEAD pass → fail → pass remains representable even when reads share a clock instant. Unchanged complete observations advance one bounded collector progress row instead of appending events. Its committed-source reference and CI watermark survive projection rebuild; a delayed failure cannot overwrite a more recently re-observed pass. This progress row is durable private storage, not derived projection state. The merge preserves sparse fields and orders CI using the CI observation's own time. A newer complete unknown/empty result supersedes an old pass. Within the same closing period, a sparse webhook with `ci: null` retains existing source-bound evidence. Across a later closing period, reviews retain their commit associations and prior CI moves to `ciHistory`; it is current only when its matching-HEAD observation is at least as new as that closure. A new period with no current CI therefore displays unknown without erasing the older evidence. Dismissed reviews remain dismissed. Terminal identity conflicts are refused before append.

Webhook, single/batch tracking and repository reconciliation converge on the same fact collection. Immutable provider closure/fact history decides admission; native decline alone is not a provider closure. An automatic old terminal snapshot cannot append reviews/comments or change activity while terminal facts are missing, including while the derived object is absent during rebuild. The explicit native action enrolls that history. Owner-authored terminal webhooks retain the no-intake-notification policy. A verified current provider read can record `pr.open_observed` after a prior closed-unmerged period. Request and provider-update times reject older observations; merged provider history cannot reopen. A signed reopened webhook re-reads current provider state, so an old delivery cannot enroll a still-closed historical subject. Reconciler first-run baselines capture this new opening quietly, without intake or native work. The existing board and inspection view show the current open HEAD with unknown CI and retain older closing facts separately. A later new closure captures its own final facts. Admission covers the entire provider observation: rejected stale terminal facts cannot still append lifecycle or cascade work. Enrolled terminal subjects continue complete provider reads on the existing cadence after pass/fail; unchanged reads update bounded progress rather than growing the journal. This adds provider-read and progress-write cost within that lane. Unenrolled legacy subjects use summary reads only.

## RED and source validation

Seven initial behavior assertions failed for the intended reasons: the real Community runtime retained an old HEAD, both exact and batched terminal provider reads returned pending despite a successful rollup, and a foreign subject was accepted. These were observed before implementation, rather than inferred from a probe's output. The subsequent tests invoke production entrypoints and journal/projection owners.

Final package validation:

- `pnpm --filter @clowder-ai/github-operations typecheck`: exit 0.
- `pnpm --filter @clowder-ai/github-operations build`: exit 0.
- `pnpm --filter @clowder-ai/github-operations test`: **860/860**, zero failures or skips.
- `git diff --check`: exit 0.

Coverage includes same-batch final HEAD/review/merge, closed without merge, explicitly reconciled terminal history, sparse/concurrent/out-of-order observations, CI rerun ordering, stable rebuild, wrong subject/commit/review parent, incomplete and paginated CI, unknown CI, caller/configuration revocation and shutdown. Existing review dismissal, notification and tracking tests also pass.

Independent review found three additional failures: reversed append/apply order lost an earlier native verdict, scheduling automatically enrolled historical subjects, and a later CI failure/unknown could remain an old pass. All three were reproduced before their fixes. Regression coverage uses independent projectors, interruptions before/after state saves, the real scheduled runtime, and complete unknown versus sparse webhook input. The same authorization failure was also reproduced and fixed at tracking retry and signed webhook entrypoints. Cursor adoption separately exposed a cross-subject link regression, which was reproduced and fixed. Existing tests that directly saved unjournaled derived state were changed to seed real journal events, preserving their original authority and concurrency assertions.

The second independent review supplied six further counterexamples: a future link backdated into an earlier merge, a lost pending cascade after tail failure, historical review/activity append, admission during a missing-cache rebuild window, a new provider merge after native decline, and unchanged observations growing the journal. Expected-behavior regressions failed 6/6 before their fixes. Further checks cover fresh-projector recovery, child-write/parent-ack failure, reciprocal concurrency, unchanged-read watermarks across rebuild and review dismissal, same-clock return to pass, and the historical action's restricted scope. The action preserves original pending or not-yet-projected work without performing it.

The third independent review found native terminal reactivation through the real observe→collect order, a missed new close after an observed provider reopening, and sparse merged input erasing prior closing review/CI evidence. The three expected-behavior assertions failed 3/3 before their fixes and now pass. The sibling sweep covers native decline/close/merge, quiet repository baselines, signed reopened deliveries with a fresh provider read, old open/close ordering, current versus historical CI, exact provider identity, and rebuild. An additional two production-entry checks failed when whole-observation admission was removed and pass with it restored; neither a stale webhook nor reconciliation may append the rejected closure’s lifecycle tail. Old transport fixtures now include actual PR numbers, URLs and complete HEADs instead of bypassing identity validation.

The fourth independent review exposed an interrupted-write gap: the open event was committed but its provider-update clock was not normalized into the comparison field, while the successful checkpoint normally supplied it. A failed checkpoint allowed an old signed close to reach lifecycle/notification handling. Two expected recovery regressions failed before repair, with an old checkpoint and with none. Explicit journal-clock normalization and required internal comparison keys now preserve the ordering fence without a successful checkpoint. The cases recreate the consumers, reject the stale signed webhook without new facts/lifecycle/notifications, rebuild the open view consistently, and still accept a genuinely later merge while retaining native history. Other clock constructors and their projector/checkpoint consumers were checked; no additional store, fallback, or recovery service was added.

## Installed consumer

The repository's `scripts/pack-publish-artifact.mjs` produced an unpublished archive. A new directory installed it with ordinary npm and its registry-pinned dependencies, without workspace dependency overrides or symlinks. The installed package's SDK is `0.3.0-beta.2-candidate.11`.
All 775 published package files were compared byte-for-byte against the source build and package inputs.

The paired test runs the complete installed factory and SDK through an actual Host worker and native invocation/storage facades. Its Redis child uses a private Unix socket (`--port 0`); it never discovers a running Host, uses inherited Redis URLs or connects to production data. The explicit compatible Host checkout was `5628446293b1c5b341d2764c4b03b7d00695d402`. The ordinary main checkout's old `dist` lacked the required indexed capability, so that initial environment failure is not represented as a candidate failure or a green result.

The candidate provider independently read the final public PR snapshot, including its matching review commit and 20 actual CI contexts (19 success, 1 skipped). Read-only sibling applicability checks of public PRs [#1779](https://github.com/zts212653/clowder-ai/pull/1779) and [#1787](https://github.com/zts212653/clowder-ai/pull/1787) also returned merged final HEADs, explicitly matching reviews and 20-check passing CI evidence through the same candidate provider. Their private native histories were not queried or repaired.

The paired installed-worker scenarios passed **2/2**, zero skips. The first feeds that captured snapshot into an isolated historical case:

- Native verdict submission still returned `409 subject_terminal`; its real persisted `not_recorded` diagnostic remained byte-for-byte unchanged after repair.
- The final HEAD/review/merge/CI facts were returned by the supported native repair and subject inspection actions.
- Original native delivered HEAD/reviewer history and the done generation-5 subscription remained unchanged; no notifications or wakes were sent.
- Worker restart plus an identical repair exercised the duplicate/rebuild path, with identical inspection readback and no extra business event.
- Two scheduled reconciliations before explicit repair left the historical subject unenrolled. After repair, controlled provider CI pass → fail → unknown observations flowed through the actual installed scheduled action. Restart/rebuild plus the older original snapshot retained unknown. These later CI changes are isolated fixtures, not claims about the public PR changing.
- A complete identical read at a newer clock time returned `unchanged` with identical event history. Both legacy event history and the entire derived projection remained unchanged during the two pre-repair schedules.

The second uses synthetic provider closed → open → merged snapshots through a newly authorized subscription and the actual Host poller’s observe→collect sequence. It captures the new final HEAD/review/CI while preserving the original native reviewer, terminal lifecycle, done subscription and refusal diagnostic. Only the new subscription receives its own one terminal notification; the original native review has no new wake. This scenario does not reopen or write any public PR.

Reproduce with explicit roots after installing a freshly packed candidate:

```sh
CLOWDER_GITHUB_TERMINAL_HOST_ROOT=/absolute/compatible-host \
CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT=/absolute/fresh-consumer/node_modules/@clowder-ai/github-operations \
node --test packages/github-operations/test/host-terminal-facts.mjs
```

Optional `CLOWDER_GITHUB_TERMINAL_SNAPSHOT` supplies a private provider-captured snapshot for isolated acceptance. Without it the test uses public synthetic data. Captured provider bodies, credentials, private thread evidence and raw logs are not committed.

Candidate archive SHA256:

`0eda6f0511a2f66040c86c70aa19c46801bc3e0b68d543d89dfa986a94cc2f43`

This archive still carries the source version `0.1.0-alpha.37`; it is an unpublished review candidate, not the immutable published alpha.37 package. Exact archive identity distinguishes it. A separately authorized release must allocate the new version and align its release/catalog metadata before publication; the old published version must never be overwritten. The full release/catalog gate is not claimed here.

## Delivery boundary

Source repair and isolated candidate validation do not prove a production historical repair. Independent review is still required. This work does not merge a publishing branch, publish npm packages, activate catalogs, upgrade a running installation or mutate a real historical subject. The installed version and original production view therefore remain unchanged until those separately authorized steps are performed and read back.
