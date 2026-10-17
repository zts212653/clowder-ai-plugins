---
feature_ids: [F202]
topics: [github-operations, source-parity, migration]
doc_kind: implementation-evidence
created: 2026-10-09
---

# Remaining source disposition at alpha.9

Audited runtime source: `f639adde8b90475f79e8e95f1b3871597936641f`.
Frozen input: Host `496e24089ffb5f99fa241e04c7ee0850df227be4`, package copy
`6636763168865f4f916b36fce510087d1595df3a`. This documentation update does not
change the alpha.9 archive, source acceptance, or runtime behavior.

The twenty residual `copied-unadapted` labels were not twenty proven missing
implementations. Reading every target, its importers, the runtime adapters and
the named tests establishes seven active implementations, two type-only
contracts and eleven inactive copies. All twenty frozen input SHA-256 values
match the original package-copy commit. The audit script scans static import
and export declarations in `.ts` files under `src` and `test`; it does not scan
JavaScript tests or dynamic imports. Its reachability is only a navigation aid,
not a source/test absence proof. A zero pending-disposition count is not zero
remaining parity.

## Active implementations: seven

| File under `src/business` | Actual runtime edge | Remaining limit |
| --- | --- | --- |
| `domains/community/CommunityEventLog.ts` | `CommunityRuntime` constructs SDK CAS journal; reservation recovery and global dedup have source tests | Historical metadata import is inert and is not an active journal migration |
| `domains/community/CommunityObjectStore.ts` | Private SDK projection storage, canonical subject key | No Host case ownership replacement |
| `domains/community/CommunityRepoConfigStore.ts` | Private SDK CAS configuration; register first calls Host `threads.bind` | No private principal/admission authority |
| `domains/community/community-keys.ts` | Runtime uses `issueCommentEventId` and `reviewEventId` | Redis constants in the same file are not evidence of live Redis use |
| `domains/community/community-projector.ts` | Ordered journal projection/rebuild is called by Community runtime | Retained `case.*` reducer branches do not authorize authenticated case transitions |
| `domains/community/reconciliation/CommunityReconciliationFindingStore.ts` | Private SDK CAS finding state; sticky waiver and reopening tests | Host case/finding/waiver consumers remain independent |
| `infrastructure/github/request-budget.ts` | Shared provider request quota, deadline, bounded queue and child-close handling | No new final-HEAD Host/CI or real-account acceptance from this audit |

Tests read, not rerun: `src/community-storage.test.ts`,
`src/repo-poll-lifecycle.test.ts`, `src/plugin-entrypoint.test.ts`, and
`src/github-provider.test.ts`. Historical alpha.9 tests and artifacts remain
bound to their original checkpoint; this source classification adds no test
pass claim.

## Type-only runtime contracts: two

- `infrastructure/connectors/github-repo-event/ReconciliationDedup.ts`: scanner
  and webhook use the type; `CommunityRuntime` supplies SDK private baseline and
  notified-state operations. The copied Redis-backed class is not instantiated.
- `infrastructure/connectors/github-repo-event/types.ts`: scanner, webhook and
  provider briefing use signal/configuration types; no runtime authority exists
  merely because a type contains a destination or identity field.

## Inactive copies: eleven, retained pending their specific disposition

| File | Current alternative or retained boundary | Unproven part |
| --- | --- | --- |
| `community-delivery-policy.ts` | Active issue classifier and tracking/webhook filtering | Whole old delivery-policy equivalence |
| `github/GitHubIssueFetcher.ts` | Provider list/state and observation inspection; legacy JS helper tests remain | Legacy labels-to-issueType/state mapping is not the current read model |
| `github/GitHubPrFetcher.ts` | Tracking/review observations | Legacy reply-state/latest-reviewed-SHA mapping |
| `narrator/community-narrator-eligibility.ts` | Host case/bootstrap narrator admission retained | No package narrator admission or Host deletion claim |
| `email/ci-message-content.ts` | Tracking constructs bounded notifications and durable outbox | Legacy lifecycle text/continuation equivalence |
| `email/pr-tracking-keys.ts` | Private SDK tracking state | Old Redis state copy/caller retirement |
| `email/severity-parser.ts` | Bounded provider notifications | Old aggregate severity-header behavior is not called |
| `github/comment-cursors.ts` | Provider snapshots establish separate registration baselines; legacy JS helper tests remain | Every old caller's replacement/cutover |
| `github/github-object-validator.ts` | Authenticated Host admission/lookup boundary retained | Current provider errors do not prove typed lookup consumers replaced |
| `github/repo-poll-readers.ts` | `GitHubProvider.listOpen/repoComments/state` | Old updated-order query differs; new reader also reads issue metadata. No data-loss reproduction established |
| `github/self-login-resolver.ts` | Provider refreshes login through `user` in active reads | Cached resolver's credential-switch/failure behavior is not automatically equivalent |

The eleven inactive rows have no runtime-source import. The independent review
found two legacy JavaScript tests omitted by the static TypeScript scan:
`test/github-issue-fetcher.test.js:8` dynamically imports `GitHubIssueFetcher.js`,
and `test/github-comment-cursors.test.js:4` dynamically imports
`comment-cursors.js`. A follow-up search across both `.ts` and `.js` files in
`src` and `test` confirmed these references. The runtime classification stays
7/2/11; it does not assert absence of test coverage. This is **not** authorization
to remove Host callers or change the behavior expectation. The files remain present. Repo comment
pagination is completed before the poller commits its maximum cursor; missing
`sort=updated` alone therefore does not establish a lost-event bug.

## Actual remaining integration boundary

Ruling286 (`thread_mrkn6povq4zzgh45#0001791450378743-000286-db15cc79`)
retains authenticated canonical verdict/lease handling in Host and leaves
GitHub-specific provider proof adapters to split during Host cutover. Current
Host `pr-review-event-wait-coverage.ts` still verifies the exact trigger's
repository/PR, `@codex review` text, creation time, the exact bot's EYES reaction,
and absence of subsequent bot feedback across complete pages. The authenticated
callback consumes that result before granting the existing wait coverage.

Package cloud observations are not that proof. Do not delete this Host adapter
or claim its consumer replaced from alpha.9's dismissal tests. The next
cross-owner step is to reconcile the existing Host cutover inventory and
consumer boundary, not invent plugin principal/lease fields or reopen the
closed mixed-case history P2. No new SDK surface is established by this audit.

The final W3 strict owner-origin review, same-final-HEAD full gate, Host
acceptance, CI, distribution, UI/MCP experience and operator soak remain open.
Alpha.6 full gate, alpha.7 Host history acceptance and alpha.9 bounded artifact
validation stay distinct historical records.
