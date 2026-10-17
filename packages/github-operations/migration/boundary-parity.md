---
feature_ids: [F202]
topics: [github-operations, migration, authority]
doc_kind: implementation-evidence
created: 2026-10-08
---

# Boundary disposition and remaining parity

## Exact-trigger provider observation

Host ruling1069 (thread_mrkn6povq4zzgh45#0001791525103936-001069-de055173)
accepts the existing instance-targeted invocation transport and pure package
query, not a trusted proof provider or callback cutover. Alpha.11 adds
`github.review-trigger.observe` with exactly repoFullName, prNumber and
triggerCommentId. It returns the existing covered/uncovered observation union;
it never consumes principal/lease/route fields, writes state, emits messages,
registers tracking or calls any GitHub mutation.

The real SDK carrier rejects undeclared actions (preserved RED evidence).
Therefore the query uses an ordinary read-only tool contribution
`github_observe_review_trigger`; no public SDK extension or hidden action bypass
is added. Discovery or direct tool invocation confers no proof authority.
Future governance consumption must still choose a trusted exact instance via
Host policy and invoke it by instance, not first-active plugin-ID tool lookup.

The query checks exact comment identity, fixed api.github.com subject origin,
repo/PR path, review command, creation time and exact connector Bot EYES. It
folds all pages from each of reviews/inline/conversation feedback, matching bot
login/type and timestamps at or after the trigger. Requests share the migrated
credential budget/child-close handler. Each endpoint permits at most 100 pages
of 100 rows, each process has the existing 2MiB buffer limit, and one observation
has a 30-second deadline. Any incomplete/oversized/malformed evidence throws;
limits are not interpreted as a clean result. Pages are folded without retaining
the full history. The stricter provider-origin check rejects forged same-path
URLs rather than inheriting the old helper's path-only acceptance.

Stop aborts secret wait and running requests, then joins outstanding provider
cleanup; a stopped reader cannot start another query. Test-only clock/deadline
defaults and submitted_at/created_at selection preserve explicit meanings, not
alternate trust or success fallbacks. There is no old-helper retry/fallback.

Source tests cover later-page EYES and each feedback stream, timestamp equality,
wrong subject/command/actor, malformed evidence, page exhaustion, deadline and
stop join. Real manifest-to-module tests prove raw observation return with zero
storage/notification writes and awaited teardown. These remain isolated
provider tests until exact packed verification is separately recorded.

Host policy currently lacks purpose-specific approved provider binding and an
activation fence carried through admission. Same-ID/digest stop/start, grant
revoke/restore and runtime recovery are still Host negative-test obligations.
No alpha.11 artifact is trusted for governance by this change. Host callback
422/503 behavior, baseline/current-HEAD adapters, canonical verdict/lease writes
and old-caller retirement remain unchanged and independently open.

Source: Host `496e24089ffb5f99fa241e04c7ee0850df227be4`. Original copies remain
in package commit `6636763`; source-map hashes identify every input. Removing
replaced copies from the package is not deletion of any Host implementation.

Operator task204 corrections243/256 establish a continuously enabled client
plugin, private tracking, existing SDK storage/message and builtin stop cleanup.
Old TaskStore automationState, wait generations, continuation carriers and
gate-keeping thread stamps are not new plugin prerequisites. The package's
registration tools accept destinations; they do not accept governance identity.

Codex's source audit ruling `thread_mrkn6povq4zzgh45#0001791450378743-000286-db15cc79` retains ExternalReviewVerdictService and
its authenticated canonical verdict submission in Host governance. Both copied
authority-bearing files were removed, not excluded from typecheck. The adjacent
coordinator retains provider observations/projection/readiness but cannot settle
typed verdicts or complete leases. Host must split its GitHub proof adapters from
the retained governance consumer during cutover.

Ruling338 (`0001791453332710-000338-54e30e41`) applies the same boundary to
request-guardian, guardian-signoff, validate-route and await-external. Host owns
authenticated principals, token issuance, assignments and admission. The copied
TriageOrchestrator also wrote durable route/acceptance fields and is removed from
the package. Its pure consensus rule is retained behind a generic recommendation
tool; supplied observation labels neither authenticate cats nor establish a
formal decision. The SDK issue metadata store rejects assignment/signoff/route
fields, including corrupt historical records, rather than preserving them.

## Verified runtime behavior

- Seven declared schedules and real SDK builtin activation, idle-without-tracking,
  registration/unregistration, provider filtering, SDK message and optional wake.
- Persistent notification outbox, restart retry, terminal final collection,
  failed collection holds tracking, stop/unregister await provider cleanup.
- Independent inline/conversation cursors, stale commit filtering, in-place
  review dismissal, review-thread resolution/reply observation.
- Review dismissal has a distinct event identity (`:dismissed`) because GitHub
  mutates the same review id; normal submitted-review IDs remain compatible.
- Self-merge records its terminal notification without waking the merger,
  including a retry after restart. No automatic repository write is activated.
- HEAD/CI observations reach the retained pure coordinator/projector through the
  real SDK builtin. This only writes private observational facts; typed verdict
  and authenticated governance callbacks remain Host-owned.
- CI billing-only failures preserve their infrastructure classification. Mixed
  code failures remain failures. Same-HEAD rerun status transitions get distinct
  event and durable notification identities; an unchanged poll stays silent.
- The fourth formal changes-requested review preserves the existing one-time
  pause of automatic wake while retaining the notification and active tracking.
- Tracking polls use package-owned time budgets and a durable round-robin
  cursor; object timeout awaits real provider cleanup. CI batches share one
  scoped GraphQL snapshot for at most twenty registrations, never a cross-tick
  mutable cache. Empty registration sets issue no provider requests.
- Declared subject inspection exposes bounded event pages and private
  projections through generic plugin tools, not a new Host route.
- Cloud request correlation uses package tracking and complete provider comment
  evidence, not Host AwaitState/continuation. Actual trigger time and current HEAD
  are checked; incremental snapshots cannot establish clean. Full inline review
  IDs survive provider pagination. Timeout and status transitions use the same
  persistent SDK notification outbox; no review-request write is performed.
- Repo scan and webhook journal/project before notification confirmation.
  Comment polling, webhook and reconciler retries repair duplicate appends via
  ordered journal rebuild, rather than skipping or applying stale events out of
  order. Real carrier storage-failure regressions cover these paths. This does
  not yet establish the full legacy-state import/recovery matrix.
- Repository scan's five-item budget, round-robin progress and failed-repo
  isolation, signed webhook admission and shared event dedup, comment collection.
- Scan, repository comments and reconciler use actual admission deadlines,
  durable fairness cursors and bounded remote reads. Timeout waits for provider
  close and cannot establish a baseline or clear findings. Reconciliation now
  establishes its quiet initial baseline per successfully visited subject,
  allowing bounded slices to progress without repeatedly restarting a global
  all-subject baseline. This adaptation preserves each subject's initial silence.

## Three separate evidence ledgers

| Area | Package business moved | Real package replacement verified | Host old implementation deleted |
| --- | --- | --- | --- |
| Tracking/provider notifications | Implemented, full source comparison pending | Builtin fake-provider journey passed; installation sources pending | No |
| Repository polling/reconciliation | Bounded package runtime implemented | Cleanup/fairness/baseline regressions passed; Host consumption pending | No |
| Triage recommendation | Pure consensus exposed via generic tool | Real YAML → builtin action passed; no governance mutation | No |
| Guardian/signoff/route/await authority | Retained in Host; copied mutator removed | No replacement claimed | No |
| Cloud correlation | Provider-only runtime implemented | Pure/provider/builtin and retry tests passed; installation sources pending | No |
| Remaining Community and state import | Incomplete | Pending | No |

## Explicitly unfinished

Ruling404 (`0001791455995015-000404-4cd051be`) keeps old Host draft ownership,
from-frustration confirmation and recovery routes in Host. New private drafts
use `github.draft.create/get` tools and `issueDrafts` Settings operation. They
do not adopt a payload userId/confirmed or old storage records. The old copied
draft store/model/source adapter/card builder and direct-fetch publisher were
removed from the package; source-map records their retained/replaced disposition.
The previous isolated SDK legacy-draft test is superseded by native carrier,
storage/concurrency and fake-gh recovery tests; the frozen 181 tests are unchanged.

| Slice | Business moved | Real package replacement verified | Host legacy removed |
| --- | --- | --- | --- |
| Provider board observations | Journal-only bounded read model | Builtin source carrier only | No |
| Public text preview | Existing pure sanitizer | Builtin source carrier only | No |
| Native draft publishing | Private storage, allowlist, owner operation, attempt journal | Builtin/fake provider and gh transport only; real Host consumption pending | No |
| Legacy draft and from-frustration | Retained Host authenticated consumer | No adoption or replacement claimed | No |

Publication response loss deliberately leaves an uncertain record. Retry performs
only GET reconciliation; absent, changed, duplicate or differently authored
provider evidence never authorizes another POST. No real external issue was
created during these checks. Published/cancelled native history has no TTL.

- Complete source-to-runtime business comparison and wider corrupted-state/event
  convergence audit.
- Legacy state copy/verify and historical cursor migration; no old state deleted.
- Remaining Community read models/drafts and complete legacy state import.
- Whole candidate build, fresh-consumer, pins/catalog, deterministic artifacts,
  full gate, independent review and Host no-double-run/cutover evidence.
- Real Host npm, local-directory and pinned-Git install → enable → run, each a
  separate pending obligation. An archive cannot close any of these rows.

Passing typecheck after removal of superseded Host orchestration would prove
compilation only. It must not be reported as business parity or full W3 success.

## Mechanical comparison and legacy copy checkpoint

`scripts/audit-github-migration.mjs` computes static runtime import reachability,
lists direct/type-only importers and validates the explicit frozen-body claims
against original copy commit `6636763` and source SHA256. Thirteen runtime-reachable
files are byte-identical; nine change only type import module paths. These 22
entries are updated individually in source-map.json. Static reachability is not
parity or installation evidence, and unreferenced copies remain visible as gaps.
The audit requires the original local copy commit; it is an author evidence tool,
not a shallow-clone consumer prerequisite.

Rulings338/463 remove unused package bootstrap/routed consumers and the automatic
rebase/push executor from both source and clean build output. Host copies remain.
New owner-confirmed raw issue metadata import has real builtin and insert-only
CAS/recovery coverage. It intentionally does not migrate assignments, route
acceptance, signoff, old drafts or pending wake authority. See
`legacy-state-disposition.md` for each remaining state class and missing evidence.

## Legacy admission helper audit

Rulings286/338 also apply to the unused `GuardianMatcher` and
`pr-review-event-wait-coverage` package copies. Three checks establish the scope:
the frozen Host callers, all package imports/exports and tests, and the static
entrypoint reachability report. Neither helper has a package caller. The boundary
regression first failed while both source files existed and now checks both source
and clean build output, plus their explicit non-replacement source-map status.

- Host `routes/community-issues.ts` authenticates the principal and roster,
  checks the accepted case and existing assignment, calls `resolveGuardian`,
  then persists the guardian and issues a signoff token. Removing the package's
  alternative private-roster matcher does not change or replace that consumer.
- Host `routes/callbacks.ts` verifies exact review-trigger provider coverage
  before creating owner-fenced AwaitState. The copied verifier itself reads
  GitHub facts; it does not authorize a caller. Its unused package copy is removed
  because no declared package action consumes this admission-specific adapter.
  Splitting provider proof from the retained Host admission consumer remains
  pending; ordinary package cloud observations do not close that obligation.

The Host files and callers remain unchanged. This slice removes inactive shipped
copies, not product capabilities or Host implementations. It proves neither
legacy state copying nor no-double-run, and does not convert the remaining
unwired provider/read-model copies into completed runtime parity.

## Inactive decision read models

The five copied files `community-closure-checklist`, `community-decision-queue`,
`community-decision-queue-closure`, `community-decision-queue-types` and
`community-route-recommendation` have no package runtime or test caller. The
static audit at `6a238f1` finds only internal edges within this inactive cluster.
Neither index/entrypoint exports them nor any declared action calls them.

Source inspection establishes their role, not merely their unreachability:
the queue consumes Host case state, assigned cat/thread, direction cards and
closure waivers. It renders `/api/community-issues/*` resolve/report/waiver
actions and `/api/community-findings/*` mutations; its checklist reports Host
case closure readiness. `routes/community-decision-queue.ts` and its read-model
adapter compose these fields from Host issue/task/object stores. The
route-recommendation file only re-exports the shared Host route validator.

Under rulings 286/338, these unused package copies are removed from source and
clean build output. This does not claim that their Host board is replaced or
authorize deletion of any Host consumer. Provider-specific board presentation
and Host governance decomposition remain an explicit cutover gap. The declared
`github_repository_observations` action still exposes provider facts and
explicitly promises no governance verdict, assignment or closure action.

Five source/artifact boundary regressions fail before removal and pass after a
clean build. Package source map records each removed copy with
`hostLegacyRemoved=false` and `realPackageReplacementVerified=false`; original
frozen bytes remain at `6636763`. This is package cleanup, not full business parity.

## Review dismissal continuity

Frozen `GitHubReviewVerdicts.mergeReviewVerdicts` and its Host
`GitHubWaitRenewalBaseline.renewVerdicts` consumer retain observed review IDs and
make DISMISSED final independent of HEAD. Tracking's previous snapshot replacement
lost that rule: an omitted review erased its marker, and a stale APPROVED snapshot
could notify again, re-enter collection, or change a dismissed cloud observation
back to clean. Source regressions reproduce all three failures.

Private tracking markers now merge observations and keep dismissed IDs final.
Collection, notifications and review-wake pacing use the same change predicate.
Cloud correlation receives the remembered final state; a provider list missing
previously seen reviews cannot replace the prior cloud observation. A later
complete observation with a distinct review ID remains eligible. No new storage
shape, Host wait state, caller authority or external write is introduced.

Real SDK module coverage exercises journal/projection/notification continuity
through stop/start and stale/missing snapshots. Runtime tests also cover changed
HEAD, terminal collection and a distinct review. The frozen pure helper remains
for source comparison; its existence alone is not runtime evidence. Host-specific
wait and governance consumers remain in Host, and source-map retains
realPackageReplacementVerified=false pending exact installed-Host acceptance.

## Repository comment reader parity

Alpha.10 connects `GitHubProvider.repoComments` to the migrated repository
comment reader. The alpha.9 replacement fetched every comment page and then one
extra issue metadata response per distinct parent before returning any comments.
This changed request cost from page-bound to parent-bound inside the existing
per-repository deadline and added failure points before cursor progress. A
two-page, 101-parent fixture reproduces the unwanted metadata request and no
progress when it fails; it is not evidence of a measured production timeout.

The active reader retains `sort=updated`, `direction=asc`, `since`, full-page
completion and cancellation. The provider reads identity once and comment pages
only. Parent kind uses the HTML URL's repository/kind/number path, checked against
the requested repository and issue number. A plain `/pull/` substring mislabels
issues owned by the legitimate account `pull`; that regression also failed before
the exact-path fix. Malformed/mismatched parent URLs fail before any collection,
and null bodies keep the provider's previous empty-string normalization.

`github-provider.test.ts` exercises the actual provider and poller together:
issue-only journal collection, PR-only cursor progress, incomplete-page zero
writes, bounded request count, and parent-path refusal. These are isolated
transport tests, not live GitHub or installed-Host acceptance. API field/query
reference: [GitHub issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository).
The source-disposition audit at f639add remains historical; this one formerly
inactive helper now has a runtime caller. Its other factory methods are not
claimed as activated by this change. Host legacy readers remain untouched.


## PR provider index: staged repository generations

The explicit `github.pull-requests.refresh` action fetches one page of 25 PRs
and bounded review pages for open subjects. Each successful review page or subject
is persisted before advancing; the draft holds immutable PR metadata, subject
offset, review page and the latest non-author review fold. Repeating the same repo
after a timeout or restart resumes the unfinished review page instead of redoing
completed subjects. One provider request must finish within its deadline; the
whole 25-subject page need not. The existing 100-review-page cap fails explicitly
without publishing a partial fold. `restart: true` abandons the staging
reference and begins again. Only a short or empty final page publishes one root
CAS; a full page is never treated as complete. A 5,000-subject limit returns
`limit_exceeded` without publication. Provider pages are ordered by creation;
this is a bounded observation sweep, not a GitHub point-in-time transaction.

Existing `github.repository.observations` adds `data.pullRequests`, with provider
rows, `publishedGeneration`, `observedAt`, `refreshStatus`, `failedSubjects`, and
`nextAfter`. The separate `prAfter` cursor is generation-bound; callers restart
pagination when a newer publication makes the cursor stale. Existing journal
items and their `after` cursor remain independent. Existing `github.repository.list`
adds `pullRequestRepositories` for published-index repository discovery, distinct
from registered polling configurations. Readback does not fetch the provider.

Each generation uses immutable chunk keys. Failed pages/reviews, timeout,
malformed data, cross-page duplicate subjects, stop and root-CAS conflicts never
replace the published rows. Failed-attempt metadata is separate and bound to the
root revision it observed. Staged and superseded immutable chunks are retained;
no TTL or destructive migration is introduced. This retention needs an explicit
compaction policy before indefinite scheduled refresh is enabled (this action
adds no schedule). No old row is presented as refreshed by a failed attempt.
Terminal PRs clear `lastReviewedSha`; draft and reviewed SHA update even when
`replyState` does not change. The mapped fields carry no reviewer approval,
assignment, principal, lease, signoff or admission authority.

Host cutover is **not implemented** by these package entrypoints. At frozen Host
`c0201d1`, UI `CommunityPanel.handleSync` still posts `sync-prs`; that producer and
`/api/community-repos`, `/api/community-board`, and the decision-queue read model
still consume the old in-memory PR store. The cutover contract is to delegate
sync to the installed instance until publication or explicit incomplete/failure,
read the package's published generation in all three surfaces, and overlay Host
task/thread/owner/status/automation fields there. Show stale/incomplete metadata;
never silently relabel prior rows as this refresh. Prove single producer and
consumer switching before retiring the old fetch/store. Fresh installation is
supported first; the old in-memory index creates no required historical-copy gate.


### Stable consumer identity and provider activity (alpha.13)

Rows expose canonical `subjectKey = pr:<lowercase repo>#<number>` and numeric
`updatedAt` from validated GitHub `updated_at` (UTC epoch milliseconds).
`publishedGeneration`/`observedAt` identify publication, not row identity or activity.
A new sweep of unchanged provider rows must not change their key or activity time.
Old alpha.12 rows lacking activity time explicitly require refresh; their date is
never invented from generation time. Starting with alpha.14, all unversioned
alpha.12/alpha.13 drafts restart automatically from page 1 into a new generation;
old chunks remain untouched and cannot enter the new published generation. Only
drafts marked `rowSchema: 2` resume their persisted subject/review-page progress.
An unknown future row schema is rejected. A failed first request preserves the
old root, and the previous published snapshot remains visible until replacement.
The frozen alpha.12 page-bound storage fixture and its alpha.13-touched variant
prove restart, failed-fetch preservation and complete/read consistency. Its
source HEAD and runtime digest are recorded in the fixture; activity timestamps
are fetched again from the provider, never synthesized.

Frozen c0201d1 consumer contract: repository discovery merges the distinct
`pullRequestRepositories[].repo` values with Host issue/task sources. Board and
queue PR-only rows map `taskId <- subjectKey`, `prNumber <- number`, and
`updatedAt <- updatedAt`; title/author/state/replyState/headSha/draft are provider
fields. Their group is terminal state or open replyState. Host tracked PRs retain
Host task identity, ownership, thread, automation and activity time; suppress the
matching PR-only row by number. Neither a fresh UUID nor sweep time is a valid
substitute for provider identity/activity. The real module test constructs all
three shapes and is reused against packed bytes; it does not execute the Host
routes and does not prove caller retirement or cutover.
