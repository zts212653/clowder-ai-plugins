---
doc_kind: evidence
created: 2026-11-12
updated: 2026-11-12
---

# Direct reads for a known GitHub wait

Accepted execution: `thread_mweftppnaau5ka72#0001794541752176-000044-05ecd815`.
Original Task `0001794535939649-002321-f78681d1` remains owned in
`thread_mw04rbpywhnzjifm`; this implementation does not create or move a Task.
PR: https://github.com/zts212653/clowder-ai-plugins/pull/228.

## Problem and source evidence

- The original 34-page report is `thread_mw8zaepivvrzbv57#0001794454521764-000979-7960793d`.
- Message `0001794450631202-000881-fb5816c4`, read in full through `get_message`,
  actually belongs to the daily triage home. It reports 107 complete tracking
  pages and 54 registration-diagnostic pages. The supplied legacy owner-thread
  coordinate returned 404; it is not the verified location of that message.
- `tracking-status.ts` previously called storage.scan before applying repo,
  cat and thread filters. Existing page limits bound each call, not the total
  work needed to find a known object. `github_inspect_subject` reads the journal,
  not the wait or its registration diagnostic.

## Read contract and actual addressing constraint

`github_list_tracking({subjectKey:"pr:owner/repo#123"})` derives the existing
native subscription ID from canonical subject and authenticated user/cat/thread.
An optional cat/thread selects an original route within the same user's visible
records. The existing key helpers are shared with the writers; ID bytes do not
change. `view:"recovery"` additionally addresses the existing subject collection
and journal metadata, with the journal's original event checked for route identity.

Imported waits deliberately retain arbitrary original IDs. Neither their typed
key nor a compatible migrated issue key can be derived from subject alone.
Providing the original `taskId` reads those original records directly. The
registration diagnostic key already hashes user/cat/thread/registration intent;
`view:"diagnostics"` therefore requires the original `registrationId` together
with subject. No new subscription ledger, reverse-index census or shadow cache
is introduced. A secondary subject index would require new writer/backfill and
concurrency semantics, while the accepted query can consume these existing keys.

`page.lookup.coverage` declares `native_subscription`, `task` or `registration`.
`legacyTaskIdRequired:true` explicitly limits a native miss; it does not prove
that arbitrary imported history is absent. With unknown original IDs, ordinary
list/pagination remains available. Direct lookup is read-only and does not run
GitHub requests, census, registration, retry or repair. Baseline, generation,
recovery revision/scope, sourceRevision, owner, cancellation/expiry, redaction,
byte limits and continuation rules remain with the existing records/projections.
Architecture ownership and state-owner map are unchanged.

## Verification

Observed RED: the new known-subject action tests failed because the old strict
schema rejected subjectKey. Baseline: 7 existing status tests passed. GREEN:
12 status tests, build/typecheck and 982 package tests passed without skips.
Tests prohibit scan/list during direct queries and cover presence, absence,
different user/cat/thread, imported typed IDs, compatible issues, registration
diagnostics, all recovery owners, cursor fencing, cancellation/expiry and redaction.
A target action used 2 storage GETs both before and after adding 3,000 unrelated
waits, including the module's existing guard read.

The self-contained alpha.45 was extracted and loaded through the actual native
Host worker, installed SDK and a privately owned portless Redis. A real MCP SDK
client/server used the built Plugin Manager handler and manifest tool identities;
only inventory/HTTP forwarding was adapted to the isolated installed fixture.
Provider observations and final message receiving were controlled synthetic inputs.

Three exact queries (subject recovery, registration diagnostic, absent subject)
used **9 HGETs at both 1,000 and 10,000 unrelated waits**. Redis MONITOR observed
10 commands including its ECHO barrier, zero HSCAN/key scans/private full-hash
reads, and zero provider reads during lookup. The returned scope/revision fed the
original `github_retry_tracking`; it preserved the original business task, then
delivered the original generation once. A compatible migrated issue was also
read through MCP by its original ID.

The additional packaged-reader probe retained ordinary pagination, stderr/cause
redaction and title omission markers. It matched 25 of 300 records in 5 pages;
the largest page was 5,279 bytes. All original storage bytes stayed unchanged.

Reproduce with explicit capable Host and extracted artifact roots:

```sh
node --import tsx packages/github-operations/test/packed-tracking-status.mjs /absolute/extracted/package
CLOWDER_1843_HOST_ROOT=/absolute/host CLOWDER_1843_GITHUB_ARTIFACT_ROOT=/absolute/extracted/package \
  node /absolute/host/packages/api/scripts/with-test-home.mjs node \
  --import /absolute/host/packages/api/test/helpers/setup-cat-registry.js --test --test-concurrency=1 \
  /absolute/worktree/packages/github-operations/test/host-exact-tracking.mjs
```

Local logs: `/tmp/github-tracking-exact-{red,green,package,typecheck,native,packed-consumer}.log`.
The standard archive is recorded by `/tmp/github-tracking-exact-pack.json`;
the self-contained archive SHA256 is
`018c4fcaaeea2b42fbafe38355e71337b8f372c1202dabe59135e28a3d29fcf3`
(5,643 members, 136 installed packages, zero symlinks, relocated entrypoints loaded).

## Delivery boundary at author self-check

The live original instance was verified as alpha.44/running before this change.
The candidate catalog includes alpha.45 with an explicit deferred public-release
plan; public discovery remains on its existing version. Independent Sonnet
review, final required gates, merge and actual original-instance adoption are
subsequent delivery evidence. A built archive or merged PR alone does not show
that the installed caller can use this input. Final receipts stay with the PR
and the authorized execution/home return rather than rewriting reviewed evidence.
