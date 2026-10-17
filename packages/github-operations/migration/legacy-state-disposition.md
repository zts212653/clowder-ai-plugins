---
feature_ids: [F202]
topics: [github-operations, state-migration, authority]
doc_kind: implementation-evidence
created: 2026-10-08
---

> Current migration scope (operator1504/1607, 2026-10-15): the four import
> settings and production import actions described below have been withdrawn.
> These are historical implementation notes, not setup instructions or required
> migration work. Existing stored records remain readable and are not deleted.

# Legacy state copy — separate provider metadata from Host authority

Frozen source: Host `496e24089ffb5f99fa241e04c7ee0850df227be4`.
No production Redis read, legacy deletion, automatic cutover or Host modification
is performed by this implementation. An import digest is a transport integrity
check; it does not authenticate a user, assignment, origin or governance verdict.

## Implemented slice: issue metadata

Source serialization: `packages/api/src/domains/cats/services/stores/redis/RedisCommunityIssueStore.ts:177–225`.
Frozen full-file SHA256: `37c399e9ebf7d74345886b81adf632fea22551413e48460317885e3014c9660f`.
The existing owner-local operation carrier invokes the declared
`legacyIssueObservations/import` → `github.legacy-issues.import` method. The
manifest has an explicit confirmation. As with other generic operations, the
method receives `{input:{...storedConfiguration,...envelope}}`; its wrapper
extracts only the protocol fields. It is not registered as a general tool.

Envelope:

```json
{
  "protocolVersion": 1,
  "sourceDigest": "lowercase SHA-256 of canonical snapshot bytes",
  "snapshot": {"issues": {"legacy-record-id": {"id": "legacy-record-id", "repo": "owner/repo", "issueNumber": "1", "issueType": "bug", "title": "Title", "linkedPrNumbers": "[]", "createdAt": "10", "updatedAt": "20"}}}
}
```

The Host adapter must supply owner-selected raw hashes without interpreting
GitHub business fields. This adapter is **not implemented or accepted here**;
current evidence is the real package/SDK builtin with isolated raw snapshots.
Snapshot `issues` is the only top-level member. Sort raw record IDs and hash
field names with JS default UTF-16 `.sort()`, serialize every key/value using
`JSON.stringify`, and concatenate compact JSON without whitespace. Raw string
contents are not parsed or normalized for hashing. Only the package subsequently
decodes its selected metadata fields. Total protocol envelope ≤256 KiB; ≤500
records. The complete batch, digest and duplicate subjects are validated before
the first write. Unknown hash fields fail rather than silently guessing a new
legacy schema.

| Legacy field | Package disposition |
| --- | --- |
| repo / issueNumber | Validate, lowercase repository, derive private subject ID |
| issueType / title | Validated metadata, not a formal triage decision |
| linkedPrNumbers | Decode and validate positive safe integer array |
| createdAt / updatedAt | Preserve safe nonnegative integer timestamps |
| id | Verify raw map identity; never adopt as package identity |
| lastActivityAt / lastActivityEvent | Do not copy governance activity prose; private metadata gets `legacy-metadata-copy` at source updatedAt |
| state / replyState / consensusState / ownerDecision | Remain Host truth; not stored or projected by import |
| assignedThreadId / assignedCatId / guardianAssignment / routeAcceptance / routeSource | Remain Host authority; not decoded, stored or trusted |
| directionCard / relatedFeature | Remain Host; no private context copied into provider metadata |

Each destination record is one insert-only SDK CAS. Existing identical rows
count as `identical`; different rows, including later owner edits, count as
`preserved`. A failed batch may have copied earlier rows: retry safely completes
missing rows, never replaces any row, and reports counts for that invocation.
There is no TTL. Corrupt existing records fail visibly and are preserved.
The receipt contains digest/counts/scope only, no old IDs, private actors, tokens
or bodies. `github_issue_metadata` reads the result by repository/number and
labels it installation-private metadata, not current provider or governance truth.

Tests cover real manifest/operation invocation, restart, whole-batch prevalidation,
numeric-looking key ordering, raw-string preservation, digest mismatch,
case-insensitive duplicate subjects, bounded input, concurrent copies, partial
storage failure, owner edits, abort, corrupt existing data and zero notifications
or tracking. These tests do not prove production export/copy/no-double-run.

## Implemented slice: inert repository progress copy

Frozen provider key definitions are `ReconciliationDedup.ts` (baseline and
notified strings) and `domains/community/community-keys.ts:30` (comment cursor),
at the same Host source commit above. The existing owner-local operation is
`legacyRepositoryProgress/import` → `github.legacy-repositories.import`.
The method wrapper extracts the same three envelope fields from `params.input`;
merged stored configuration never enters the digest or private copy.

```json
{
  "protocolVersion": 1,
  "sourceDigest": "SHA-256 of canonical raw snapshot",
  "snapshot": {
    "repositories": {
      "example/project": {
        "f141:baseline:example/project": "1",
        "f141:notified:example/project#issue-7": "1",
        "community:repo-comment:cursor:example/project": "2026-10-08T10:00:00.000Z"
      }
    }
  }
}
```

Canonical snapshot bytes have fixed outer `repositories`, JS UTF-16 sorted
repository/key names and JSON-stringified raw values, without whitespace. No
envelope fields participate in hashing. All records are checked before writes:
≤256KiB envelope, ≤50 repositories, ≤5000 notified facts per repository, positive
safe subject numbers, strict UTC calendar timestamps, exact known key scopes,
no case-insensitive duplicate repositories. Missing keys stay absent. Foreign,
mixed-case legacy key aliases and unknown key formats fail; an owner export
must select canonical records, not silently relabel historical keys.

Import inserts one inert SDK record per repository with CAS and no TTL. Existing
active configs or different copied records are preserved. Same raw copy is
idempotent; partial failure retries only missing repository rows. Copy accepts
no config, actor, thread, route, assignment, token, wait state or journal body.
It makes no provider requests and does not bind destinations or enable polling.

On later explicit repository registration, Host thread access/binding checks
run first. Within the same runtime queue, missing scan-baseline, scan-notified
and comment-cursor keys are then restored using insert-only CAS; the active repo
config is saved LAST. Partial restore failure therefore leaves no active config,
and retry cannot roll back an existing/newer cursor. Restart preserves staging.
The first scan skips the copied notified subject and delivers a newly observed
unnotified subject; it does not rebaseline and swallow that subject. Comment
polling keeps the original one-second overlap around the copied cursor.

This does not copy the old notification destination/config automatically.
Owner registration is still required. Old Host producers must be stopped under
Host cutover ownership before registering the new producer. The package does
not authenticate a payload `confirmed` as proof of cutover. The bounded raw
export adapter, production copy, and no-double-run cutover remain unverified.
Legacy journal history is still Host-retained pending its separate disposition;
a copied collection cursor does not imply historical events were copied.

## Implemented slice: settled issue delivery progress

Before: re-registering a legacy issue takes a fresh provider baseline and can
skip comments that were collected but never delivered, including arrivals during
the move. After: an inert copy retains the old delivery frontier; explicit new
registration checks Host access/binding and resumes from that frontier.

Frozen sources are `RedisTaskCodec.ts:3–31` (raw hash serialization) and
`IssueCommentTaskSpec.ts:277–295` (collection/delivery distinction), at Host
`496e24089ffb5f99fa241e04c7ee0850df227be4`. The owner-local manifest operation
`legacyIssueProgress/import` invokes `github.legacy-issue-progress.import`.
Its wrapper extracts protocolVersion/sourceDigest/snapshot from params.input;
stored config does not enter the digest. The envelope uses
`snapshot: {tasks: {taskId: rawStringHash}}`. Canonical bytes fix the outer key
`tasks`, sort task IDs and raw hash fields by JS UTF-16 order, and JSON-stringify
each raw string without parsing/normalizing its contents. SHA-256 checks
transport integrity, not ownership, settlement or old-producer shutdown.

The complete batch validates before any write: at most 100 tasks and 256KiB,
matching raw id, `issue_tracking`, status todo/doing, canonical issue subject,
no duplicate normalized subjects, known raw hash fields and valid raw JSON
automationState. The automation object accepts only issue progress. Pending
wakes, await/other automation branches, nonempty probe/resolveMode/deploymentWait/
dispatchGate/entrustedWork, terminal state and unknown schemas fail visibly.
These exclusions require Host settlement or a separate adaptation; this is not
a complete migration of every legacy tracking task.

`lastCommentCursor` is required, nonnegative and safe integer. An explicit
`lastDeliveredCursor` must not exceed it. If delivery is absent, the old Host
single-cursor fallback applies: delivery equals the original collection cursor.
The staged private record stores only normalized subject and both frontiers;
old actors, destinations, prose, pending wake content and task identity are not
persisted. No TTL, fetch, bind, notification, registration or polling occurs.
Per-subject insert-only CAS preserves any existing registration (even inactive)
and any different prior copy. Partial failure can be retried for missing rows.

Import shares the registration's per-subject queue in the single active module.
On first explicit registration, Host bind runs before reading staging; a
copied issue skips the fresh provider baseline entirely. Its initial feedback
marker uses the delivery frontier, then one CAS activates tracking. Failed CAS
leaves staging inert and retryable. Later explicit unregister/re-register uses
normal new-registration semantics, not stale staged progress. A copy cannot
rewind live cursors. Host's single-runtime/no-double-run guarantee and stopping
the old producer remain required; the snapshot cannot attest either one.

The real builtin journey copies collected=5/delivered=4, restarts, rejects a
foreign Host target, explicitly registers and delivers comments 5 and 6 while
excluding 4. Repeated copy/poll sends no duplicate. Focused tests also exercise
concurrent staging, partial failure, registration contention/CAS failure,
single-cursor fallback, corrupt state and every authority exclusion above.
Old collected history is not claimed as imported: the new journal idempotently
collects provider facts from the delivery frontier. Historical journal copy,
raw Host export, production copy and real cutover remain pending.

This business slice was frozen as GitHub alpha.3 at3b640d7. Frozen alpha.2 at
53e80f5 and all SDK beta.14/connector alpha.4 archives remain unchanged.

## Host registration capability correction

Real Host consumption of alpha.2 exposed a package error: the preliminary
`threads.get` in both registration paths requires `thread.readContent`, which
the manifest does not request. Alpha.3 inherited that error despite its local
gate passing. Neither candidate's local tests establish actual Host registration.

The correction in alpha.4 removes both redundant reads and uses the mandatory
existing `threads.bind` as the authorization boundary. Host
`plugin-thread-host.ts:156–175,315–320` validates the ID, rejects missing/deleted
threads, checks owner/plugin ownership or an existing owner binding, and only
then persists the binding under `thread.write`. The SDK directly forwards it.
Both package paths await that check before provider reads, progress restoration
or active config CAS. No thread content is needed, no grant is added, and no
new Host API or private identity assertion is introduced.

The real builtin regression denies every content read and exercises both
registration methods. Missing/foreign/deleted bind failures leave package storage
unchanged with zero provider requests; allowed binds succeed without content
access. Existing progress-copy tests now fail at the actual bind boundary.
These isolated assertions still require new exact-archive Host consumption to
close finding762. The owner-origin independent review gate remains separate.

## Historical provider metadata (alpha.7 case-preserving transport)

Before: looking up old GitHub activity requires finding the previous Host journal.
After: a bounded event index can be copied and inspected in this installation,
without replaying old events or treating history as current notification progress.
The original journal remains the source for bodies and Host decisions.

Frozen source `CommunityEventLog.ts` at Host496e24089ffb5f99fa241e04c7ee0850df227be4
stores JSON strings in Redis LIST `community:events:log:{subjectKey}`. The new
owner-confirmed operation `legacyProviderHistory/import` receives protocol1,
sourceDigest and `snapshot: {events: {exactSourceSubject: rawListStrings}}`.
Canonical digest bytes fix outer `events`, sort subject keys in JS UTF-16 order
and preserve each raw string and its LIST order. The Host raw exporter reads
the exact source key without decoding business JSON. Exporter review and real
mixed-case Host consumption are separate from package validation.

The complete batch validates before writing: 256KiB, 50 subjects, 500 events,
ASCII repository subject/positive safe number, exact known event envelope,
nonnegative safe timestamp, known classification/kind, matching subject and
globally unique sourceEventId. Raw event subject must exactly match its source
key, including case. Two source keys with the same lowercase identity reject
the entire batch before any storage write; they are never merged or selected.
Only after all validation and digest verification are destination identities
normalized to lowercase. Unknown schemas fail, not silently disappear.
Known `case.*` events remain in Host and are counted, not persisted or replayed.
Provider lifecycle/comment/label/review kinds retain ONLY kind, timestamp,
original LIST sequence and SHA256 of their raw event. Payload, body, raw ID,
classification, principals, leases and routes are never copied. Head/CI/cloud
`case.*` history also remains Host-retained in this slice.

Each canonical subject becomes one bounded insert-only CAS record with no TTL, its raw
LIST digest and excluded-event count. Identical retries are idempotent; different
copies or owner changes are preserved; interrupted batches retry missing rows.
Across batches, case aliases address that same row. Inspection accepts the
original or lowercase repository spelling and returns the canonical identity.
Inspection returns validated metadata pages of at most100 plus a derived GitHub
subject URL. Corrupt stored rows fail closed. Import/inspection never touches
the active journal, projections, current cursors, registrations or notification
keys, even if current tracking already exists. It does not feed projector replay.

This is a historical metadata index, NOT full legacy journal/body migration.
Large histories, Host events and original bodies remain available only in Host;
raw export, exact packed validation and real Host acceptance remain separate.
Do not describe this slice as PR progress, complete journal copy or cutover.

## Other legacy state remains explicitly pending or Host-retained

| State | Current disposition | Missing evidence |
| --- | --- | --- |
| PR tracking hash / TaskStore provider cursors | Pending copy/verify adaptation | Join by canonical subject; preserve independent inline/conversation cursors and terminal/pending delivery facts |
| Legacy combined PR comment cursor | Pending historical migration | IDs are different namespaces; cannot copy one scalar into both cursors or silently baseline over new activity |
| Settled issue collected vs delivered cursors | Inert copy + explicit registration restore implemented | Raw Host export, production copy and cutover pending; unsettled/terminal tasks excluded |
| Issue pendingWake / waitOutcome / accepted assignment | Host-retained governance consumer | Authenticated Host settlement, not plugin payload replay |
| Repository config | Explicit new registration; legacy destination not adopted | Owner-selected target/access check; Host old producer stop before cutover |
| Repository scan dedup / comment cursor | Package inert copy + explicit registration restore implemented | Real Host raw export/copy and no-double-run cutover remain pending |
| Community provider journal/history | Bounded inert provider metadata index implemented; original bodies and all case.* events Host-retained | Raw export/packed/Host acceptance pending; no full journal copy or event replay claimed |
| case.bootstrap / case.routed and assignment/signoff/route admission | Host-retained under ruling338 | Existing authenticated consumers stay; package copies removed |
| Old drafts / from-frustration | Host-retained under ruling404 | Ownership/confirmation and legacy cutover not replaced by native drafts |
| ConflictAutoExecutor | Retirement candidate under ruling463 | No default rebase/push capability; Host caller retirement/no-double-run still pending |

All three ledgers remain separate: this metadata business is implemented; real
Host replacement is pending; no Host legacy implementation or data is deleted.
The previous alpha.1/beta.13 graph is preserved at473783d. Alpha.2/beta.14 is
frozen at53e80f5 with a complete local gate; that evidence does not approve this
new alpha.3 slice or establish CI, review, Host consumption or release.
