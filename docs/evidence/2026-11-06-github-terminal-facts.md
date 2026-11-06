---
title: Terminal pull request provider facts and bounded historical reconciliation
created: 2026-11-06
status: author-verified-awaiting-independent-review
---

Merged and closed PR snapshots previously discarded final HEAD, review commit association and merge/CI provenance on the way into the Community journal. Terminal CI was an unconditional pending placeholder. Retrying a native verdict correctly refused the terminal subject, so that retry could not repair the lost provider facts.

The implementation preserves final provider facts in a `pr.terminal_observed` journal event and its optional rebuildable `terminalFacts` projection. The existing subject/repository inspection surfaces use that final HEAD and source-bound CI. A review belongs to the final HEAD only when its explicit commit matches. Unbound reviews remain uncertain historical evidence. Empty rollups and cancelled-only terminal checks are unknown, rather than a fabricated pass or running CI. Original check status/conclusion and links remain inspectable.

The aggregate's provider HEAD/CI fields also advance so the existing board and status chips display the final facts. Its assignment, last reviewed/delivered HEAD and delivery history do not come from GitHub approvals. A final provider fact fences queued open-subject observations and assignments as well. The fix uses the current journal, projector, collector and reconciler owners; it adds no backfill store, service, queue or polling lane. Existing large composition roots remain in place because splitting their unrelated state-machine, webhook and lifecycle logic would expand this fix's locking and replay surface. New fact normalization and reconciliation authority live in separate modules below 100 lines each.

## Supported historical entry

`github_reconcile_terminal_pr({subjectKey: "pr:owner/repository#12"})` dispatches to `github.subject.reconcile-terminal` with the Host's authenticated native context. It accepts one existing terminal PR and requires its repository to remain configured. It re-reads the provider under an invocation, configuration and shutdown fence, validates subject/HEAD/CI identities, and appends only a provider observation. Supplied facts or authority fields are refused. An existing terminal subject is never registered for tracking, leased or woken by this action.

One provider snapshot has one deterministic event identity. Separate observations retain their times, so a real same-HEAD CI pass → fail → pass sequence is representable. The merge preserves sparse fields and orders CI using the CI observation's own time; a later sparse webhook cannot erase a complete API read. Dismissed reviews remain dismissed. Terminal identity conflicts are never projected as a new final HEAD.

Webhook, single/batch tracking and repository reconciliation converge on the same fact event. Owner-authored terminal webhooks preserve facts for already tracked subjects while retaining the no-intake-notification policy. Reconciler first-run baselines stay quiet. Successful source-bound terminal facts stop repeated full reads; unresolved CI can still be observed by the existing reconciliation lane.

## RED and source validation

Seven initial behavior assertions failed for the intended reasons: the real Community runtime retained an old HEAD, both exact and batched terminal provider reads returned pending despite a successful rollup, and a foreign subject was accepted. These were observed before implementation, rather than inferred from a probe's output. The subsequent tests invoke production entrypoints and journal/projection owners.

Final package validation:

- `pnpm --filter @clowder-ai/github-operations typecheck`: exit 0.
- `pnpm --filter @clowder-ai/github-operations build`: exit 0.
- `pnpm --filter @clowder-ai/github-operations test`: **817/817**, zero failures or skips.
- `git diff --check`: exit 0.

Coverage includes same-batch final HEAD/review/merge, closed without merge, existing terminal history, sparse/concurrent/out-of-order observations, CI rerun ordering, stable rebuild, wrong subject/commit/review parent, incomplete and paginated CI, unknown CI, caller/configuration revocation and shutdown. Existing review dismissal, notification and tracking tests also pass. The initial broad test run before a package build failed on missing `dist`; it was corrected by building the package. Subsequent failures exposed a missing feature contribution declaration and a duplicate terminal review-collection regression; those were fixed before the final green run.

## Installed consumer

The repository's `scripts/pack-publish-artifact.mjs` produced an unpublished archive. A new directory installed it with ordinary npm and its registry-pinned dependencies, without workspace dependency overrides or symlinks. The installed package's SDK is `0.3.0-beta.2-candidate.11`.

The paired test runs the complete installed factory and SDK through an actual Host worker and native invocation/storage facades. Its Redis child uses a private Unix socket (`--port 0`); it never discovers a running Host, uses inherited Redis URLs or connects to production data. The explicit compatible Host checkout was `5628446293b1c5b341d2764c4b03b7d00695d402`. The ordinary main checkout's old `dist` lacked the required indexed capability, so that initial environment failure is not represented as a candidate failure or a green result.

The candidate provider independently read the final public PR snapshot, including its matching review commit and 20 actual CI contexts (19 success, 1 skipped). Feeding that snapshot into the installed worker's isolated historical case passed **1/1**, zero skips:

- Native verdict submission still returned `409 subject_terminal`; its real persisted `not_recorded` diagnostic remained byte-for-byte unchanged after repair.
- The final HEAD/review/merge/CI facts were returned by the supported native repair and subject inspection actions.
- Original native delivered HEAD/reviewer history and the done generation-5 subscription remained unchanged; no notifications or wakes were sent.
- Worker restart plus an identical repair exercised the duplicate/rebuild path, with identical inspection readback and no extra business event.

Reproduce with explicit roots after installing a freshly packed candidate:

```sh
CLOWDER_GITHUB_TERMINAL_HOST_ROOT=/absolute/compatible-host \
CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT=/absolute/fresh-consumer/node_modules/@clowder-ai/github-operations \
node --test packages/github-operations/test/host-terminal-facts.mjs
```

Optional `CLOWDER_GITHUB_TERMINAL_SNAPSHOT` supplies a private provider-captured snapshot for isolated acceptance. Without it the test uses public synthetic data. Captured provider bodies, credentials, private thread evidence and raw logs are not committed.

Candidate archive SHA256:

`acb41fadf56d62ad4da7bd5f4e83be1d27d5e2143c5b4b604816e1f496176b2d`

This archive still carries the source version `0.1.0-alpha.37`; it is an unpublished review candidate, not the immutable published alpha.37 package. Exact archive identity distinguishes it. A separately authorized release must allocate the new version and align its release/catalog metadata before publication; the old published version must never be overwritten. The full release/catalog gate is not claimed here.

## Delivery boundary

Source repair and isolated candidate validation do not prove a production historical repair. Independent review is still required. This work does not merge a publishing branch, publish npm packages, activate catalogs, upgrade a running installation or mutate a real historical subject. The installed version and original production view therefore remain unchanged until those separately authorized steps are performed and read back.
