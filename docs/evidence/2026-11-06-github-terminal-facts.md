---
title: Terminal pull request provider facts and bounded historical reconciliation
created: 2026-11-06
status: author-verified-awaiting-re-review
---

Merged and closed PR snapshots previously discarded final HEAD, review commit association and merge/CI provenance before Community journal ingestion. Terminal CI was an unconditional pending placeholder. The native verdict endpoint correctly refused a completed subject, so replaying that verdict could not repair the missing provider facts.

The repair preserves provider facts in `pr.terminal_observed`, exposes them through existing subject/repository inspection and board views, and provides one bounded authenticated historical reconciliation action. Native reviewer/assignment, last reviewed/delivered HEAD, done subscriptions and refusal records retain their original meaning. GitHub approval never becomes native delivered status.

## One provider-period policy

`provider-period.ts` is the pure reducer for `pr.open_observed`, `pr.closed`, `pr.merged` and `pr.terminal_observed`. History admission, collection, journal replay, projection and inspection all consume it. Fact schemas and evidence merging live in `terminal-provider-evidence.ts`; that leaf receives period identity from the reducer and makes no lifecycle decision. The old history/state facades delegate to the reducer.

The reducer owns accepted state, period identity, provider/request ordering clocks, enrollment, complete-fact period binding and the original lifecycle source reference. Merged is irreversible. Rejected old events remain journal evidence but never become the next decision's baseline. Same-state sparse observations preserve known clocks; a summary transition with an unknown closure clock cannot borrow the prior opening's server clock. Equivalent UTC timestamp representations compare by instant. Both complete and summary transitions pass the same checks.

Prior-state request and provider clock floors survive every transition. A same-second timestamp needs a request strictly after the preceding state boundary; an ambiguous sparse webhook is refused until a fresh API read supplies that proof. Same-closing enrichment only exempts an older request when both closing timestamps are known and equal and the prior-period floors have passed. Missing timestamps do not create that exemption or a new period on their own. Transition rows retain any checkpoint-advanced floor, including when the following checkpoint write fails. Earlier reducer caches reconstruct the journal prefix before accepting another event.

Lifecycle normalization reuses an already committed operation's identity, including legacy reconciler IDs. A genuinely new closing period receives a distinct identity. This preserves idempotence across producers and upgrades without swallowing a second close after reopening. Valid closure/merge events clear the open marker. A summary without complete current-period facts displays its actual state with unknown CI, while previous evidence remains historical.

Content coalescing compares only facts already bound to the target period. An identical closure after reopening is recorded once, and unchanged subsequent reads add no journal rows. Both tracking and scheduled lifecycle rows retain the complete API snapshot's request clock even when its outer summary omits that field.

New periods retain review IDs and explicit commit associations, and archive prior CI in `ciHistory`. Old successful CI does not become current merely because the HEAD is unchanged or GitHub timestamps share one second. Current CI comes from that period's observed evidence. Same-period sparse enrichment preserves current source-bound evidence; a newer complete unknown/empty rollup replaces old success. Raw check status/conclusion and links remain inspectable. Unbound reviews remain uncertain and only an explicitly matching commit belongs to the final HEAD.

The existing projection stores a compact reducer cache beside its journal cursor and pending operations in the same write. Cursorless/older caches reconstruct the prefix; normal updates process the tail. Journal-order folding preserves a legitimate native verdict appended before closure even if independent producers apply in the opposite order. Pending cross-subject operations survive interruptions and resume outside subject locks. Source-bound issue associations cannot be backdated into older merges, and derived effects cannot reopen closed/reported/declined issues.

## Historical authority and normal new work

`github_reconcile_terminal_pr({subjectKey: "pr:owner/repository#12"})` dispatches to `github.subject.reconcile-terminal`. It accepts one existing terminal PR in a still-configured repository, re-reads the provider under native invocation/configuration/shutdown fences, validates subject/HEAD/CI identity and refuses caller-supplied facts or authority fields.

The action stages projection-only replay and commits one replacement. It preserves original associations and unfinished operations without executing them, creating active review/lease/wake or appending generic historical lifecycle/cascade work. Initial historical enrollment records this facts-only boundary in the existing journal. A concurrently prepared scheduled result cannot convert that enrollment into a new merge cascade. Later current fact refresh remains allowed; a genuinely new observed provider period returns to ordinary lifecycle ownership.

Automatic collectors refuse unenrolled old closure history, including its reviews/comments/activity. Admission reads canonical accepted journal events, never a transient missing cache. Signed reopened webhooks re-read current provider state; old deliveries cannot enroll a still-closed historical PR. Quiet repository baselines record genuine new openings without intake or native review work. A later actual merge emits its lifecycle event and existing linked-issue cascade even when the original native review remains terminal.

One bounded durable progress row advances source-matched read/CI watermarks for unchanged observations. It is not a prerequisite for recovering committed period clocks: checkpoint failure after append still rejects old signed closures and rebuilds consistently. Unchanged complete reads return unchanged without journal growth. Enrolled subjects continue complete reads on the existing cadence after pass/fail; unenrolled history uses summary reads. No store, resident worker, polling lane, external dependency or generic backfill framework is added.

## Author validation

Original behavior failures were observed before implementation. The latest independent review's six expected-behavior cases failed **6/6** at its reviewed source, then passed after the reducer integration. Additional failure checks during repair exposed historical-repair/scheduled-result races, coarse-clock CI reuse, old-cache reads, lifecycle identity reuse, sparse summary evidence and equivalent timestamp representations. The original reviewer probes remain unchanged; their bug assertions are not claimed as green tests.

Final source validation:

- `pnpm --filter @clowder-ai/github-operations typecheck`: exit 0.
- `pnpm --filter @clowder-ai/github-operations build`: exit 0.
- `pnpm --filter @clowder-ai/github-operations test`: **901/901**, zero failures or skips.
- `git diff --check`: exit 0.

Coverage includes original and prior review regressions, full/summary period transitions, raw rejected-event replay, checkpoint interruption, native terminal fences through observe→collect, genuine new lifecycle/cascade work, preservation of existing historical work, source identities, review dismissal, paginated/incomplete CI, caller/configuration revocation and shutdown.

## Fresh installed consumer

The canonical `scripts/pack-publish-artifact.mjs` archive was installed in a fresh directory with ordinary npm and registry-pinned dependencies, without workspace overrides or symlinks. SDK version is `0.3.0-beta.2-candidate.11`; all **783** published files match source/build inputs byte-for-byte.

The candidate provider read public PR #1783 on 2026-11-06, confirming final HEAD `361e46171726170bab6e7ecb2013402311bc32ad`, review `5746857308` bound to that HEAD and 20 actual CI contexts (19 success, 1 skipped). Prior read-only applicability checks of [#1779](https://github.com/zts212653/clowder-ai/pull/1779) and [#1787](https://github.com/zts212653/clowder-ai/pull/1787) exposed the same terminal evidence shape; their private histories were not queried or repaired.

The complete installed factory and SDK passed **5/5** scenarios through actual Host worker/native invocation and storage facades at Host commit `5628446293b1c5b341d2764c4b03b7d00695d402`. Each Redis child uses a private Unix socket and `--port 0`, without inherited production URLs. Test logging stays in private working directories.

- Captured public snapshot in an isolated historical case: supported repair/inspection/restart/rebuild agree; original delivered/reviewer history, done generation-5 subscription and real `409 subject_terminal`/`not_recorded` diagnostic remain unchanged. Pre-repair schedules do not enroll history. Controlled CI pass→fail→unknown stays current across restart and older input. Zero notifications.
- Synthetic closed→open→merged through a newly authorized subscription and actual observe→collect: new final facts are captured while the original native review and old done wait stay terminal. Only the new subscription receives its own one terminal notification.
- Historical merged facts over a previously closed native case: subsequent scheduled reads create no historical merge/cascade work and preserve the linked issue.
- Historical closed facts followed by a genuine provider reopening/merge: scheduled collection emits the new merge and closes its linked issue while preserving original reviewer, refusal and done wait. No native review wakes or notifications.
- Same-second reopening and identical closure: the new period receives its own facts, unchanged reads coalesce, and a subsequent old request is refused through the authenticated reconciliation action after Host restart. Rebuild agrees with the live projection, the original wait remains done and no notification is sent.

Consumer fixtures return distinct issue and PR responses. No public PR was reopened or written by these scenarios.

Reproduce from a private working directory with explicit roots:

```sh
CLOWDER_GITHUB_TERMINAL_HOST_ROOT=/absolute/compatible-host \
CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT=/absolute/fresh-consumer/node_modules/@clowder-ai/github-operations \
node --test /absolute/source/packages/github-operations/test/host-terminal-facts.mjs \
  /absolute/source/packages/github-operations/test/host-provider-periods.mjs
```

Optional `CLOWDER_GITHUB_TERMINAL_SNAPSHOT` supplies a privately captured provider snapshot; otherwise the original acceptance uses public synthetic data. Credentials, captured bodies, private thread evidence and raw logs are not committed.

Candidate SHA256: `225b3650317a6812e9001829c8bc306f14d9a2dad13b6f3afc363d308b64c137`.

This archive carries source version `0.1.0-alpha.37` as an unpublished review candidate, not a replacement registry release. A separately authorized release must allocate a fresh version and align release/catalog metadata. The full release/catalog gate is not claimed.

The preceding review target's Contract CI failed at step 37/39, Machine catalog, because the changed GitHub package archive differs from the existing catalog integrity. Its publish job was skipped. That release/catalog mismatch remains a separate prerequisite for an authorized release; it is not represented as passing CI by these package and consumer checks.

## Delivery boundary

Independent review of this source is still required. No publishing-branch merge, npm publication, catalog activation, production runtime upgrade or real historical write has been performed. Isolated repair validates the path; the original installed production view remains unrecovered until those separately authorized operational steps are executed and read back.
