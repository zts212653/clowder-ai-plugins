# Validation record

## Two independent flows and receiver entry — 2026-10-23

Initial classification now includes Open/Closed history once; manual categories,
version history and rule dispatch use one plugin storage record. Independent batch
dispatch needs no extra model invocation. Regression tests cover late manual edits,
paused/stopped batch fences, concurrent edits before writes, partial publication
failure and restart deduplication. Receiver owner acceptance persists separately
from execution; the UI supplies the original conversation and an explicit start
instruction. GitHub discussions retain edited/deleted authors and page version checks.

The packed page is actually served through the unchanged Host's authenticated
webhook route. Browser checks cover save/reload, later cat results preserving manual
classification, history and acceptance. Test grants/session/model/GitHub remain
explicit fixtures. Full evidence and remaining delivery constraints:
[two-flow record](../../docs/evidence/issue-workbench-two-flows.md).

## Unmodified Host integration — 2026-10-21

The exact tarball now carries canonical `plugin.yaml`; the previous package failed
real Host admission because only a candidate filename was present. `test:host`
exercises the existing Host implementation in isolated projects and a private Redis
server: install/configure/enable/disable, owner authorization and confirmation,
native analysis tools, messages, queues, browser operations, invitation/receipt,
offline recovery and withdrawal. Sender/receiver databases are independent.

The default Host policy still grants this plugin no capabilities. Functional
tests supply explicit test grants and fixtures for login, model and GitHub; no
production data, real member task or real external write is involved. Source and
critical compiled Host inputs are checked unchanged. Instructions and precise
scope: [HOST-TESTING.md](HOST-TESTING.md); [evidence](../../docs/evidence/issue-workbench-installed-host.md).
Overall `hostInstallable:false` and live acceptance gaps remain explicit.
Canonical manifest discovery also activates the repository's existing bilingual
installation-guide gate. The default README is now Chinese, `README.en.md` retains
the English guide, and the artifact check verifies both guides plus `HOST-TESTING.md`.

## Explicit classification batches — 2026-10-21

The team drawer now prepares a complete Open Issue batch and shows its size before
an explicit start. Durable serial work retains the selected Host cat and thread;
pause/stop fence future messages and automatic assignment, and restart reuses jobs.
Existing organization, source, permission and assignee rules remain in force.
This is a finite batch, not a continuous new-Issue watcher.

Runtime RED→GREEN, the packed start/pause/reload/resume/stop journey, actual remote
catalog reads and final validation outputs are described in
[the queue evidence record](../../docs/evidence/issue-workbench-classification-queue.md).
The live Host route, real cat execution and two-account assignment/intake remain
unverified. This increment does not promote the candidate manifest to installable.

## Manual/cat choice increment — 2026-10-21

The existing workbench now offers **人工研判 / 猫猫研判**. The initial manual view
can save without a team connection; cat mode uses the configured Host member list,
including visibly unavailable members. Refresh and send never substitute another
cat. GitHub Organization assignees remain separate from analysis cats.

Red→green checks cover the missing mode selector and incomplete configured roster.
All 52 team checks and six packed browser/READ journeys passed, including mode
switching without lost drafts or unintended sends, unavailable/removed/restored
selected cats, and manual save/reload after Host authorization is denied. Final
package validation and actual preview evidence accompany the PR. See
[the evidence record](../../docs/evidence/issue-workbench-analysis-modes.md).

This increment changes plugin-owned UI/runtime/tests only, plus documentation.
No Core source cut, public SDK, dependency, saved-data schema or remote-write policy
changed. Installed Host and real-cat/two-account acceptance are still pending.

## Immediate assignment and selected analysis cat — 2026-10-21

Source: `thread_mucwsgsjtlbabfcq#0001792553407782-000031-4e6d17f0`.
The issue panel loads organization members independently of analysis, displays the
existing classification, supports explicitly confirmed direct assignment, and lets
owners select a Host-routable cat. Requests carry classification plus restricted
assignment instructions; saved automatic-assignment policy still controls effects.
Pending results refresh automatically across queue, filters and detail, using source
identity and provider update stamps. Direct assignments have their own durable
record kind and do not inflate analysis/feedback statistics.

RED: no members before analysis; selected cat rejected by the old input schema;
no direct-assignment context; packed preview did not route the new owner action;
a failed direct assignment could be retried under later automatic policy; routable
cats not yet joined were absent. Targeted checks and packed journey are green.
Full validation and visual evidence are recorded in
`artifacts/assignment-flow-2026-10-21/` (final gate in `verified-run/`) and
[Acceptance record](../../docs/evidence/issue-workbench-assignment-flow.md).
No real GitHub assignment/comment, Core change or installation is implied.

## GitHub Organization roster — 2026-10-21

Source: `thread_mucwsgsjtlbabfcq#0001792547645594-000008-95c47697`.
`teamOrganization` replaces manual membership authority. The current authenticated
user's active membership is verified before paginated organization reads. The
roster is refreshed before assignment/publication/intake, while repository permission
and explicit owner confirmation remain independent checks. Missing/failed access
retains analysis/history and offers refresh instead of using a stale/manual list.

Observed RED: organization provider absent; runtime assigned the old manual member
instead of the organization member, and still assigned when organization access
failed. All 44 team checks now pass. The packed browser journey verifies organization
source/count, refreshed member links, failed refresh clearing choices while preserving
analysis, selection/confirmation/reload and existing recovery. Typecheck and build pass.
The production bundled provider read 10 `meow-club` members via the local authenticated
GitHub CLI; the local UI displays and refreshes them. Real membership reads are
separate from synthetic Issue/cat/assignment data; no real GitHub writes occurred.

Evidence and full-gate result: `artifacts/organization-2026-10-21/` and
[Organization acceptance](../../docs/evidence/issue-workbench-organization.md).
All 35 repository gate steps and all six packed browser/READ journeys passed
in the managed full run (426 seconds). All 114 captured file digests matched
on readback before this documentation-only result update. The fixed artifact
toolchain, canonical gate step list and existing Feishu pack exemption are unchanged.
Author-only verification; installed Host authorization, live-cat/two-account
acceptance and merge remain pending.

## Adjustable workspace columns — 2026-10-21

Source: `thread_mucwsgsjtlbabfcq#0001792546356337-000000-2a0451b4`
(“三栏工作区要可以调整列宽，自适应”). The original two separators now support
pointer and keyboard adjustment, bounded pane widths, persistent preferences and
reset. Container-based layout preserves drafts while moving between three panes,
queue plus reading/investigation, and one selected pane.

Observed RED: the packed page had no separator. The first implementation also
failed the embedded-width check because CSS modules gave the separator's named
container query a different name. The corrected packed journey passed, including
dragging both boundaries, refresh, keyboard/reset, clamping and restoration,
1050px/600px embedded containers, 390px viewport, unavailable/corrupt storage,
retained drafts and a visible save action. All six packed browser/READ journeys,
typecheck/import boundaries and an idempotent source-export check passed.
Desktop, dark and mobile screenshots were inspected in
`artifacts/columns-2026-10-21/`.

All 35 repository gate steps and all six packed browser/READ journeys passed
again in the managed full run (423 seconds). All 112 captured file digests matched
on readback before this documentation-only result update. The command/log and
frozen inputs are recorded in `artifacts/columns-2026-10-21/verification.json`.
The existing Feishu pack exemption is unchanged. This plugin-only layout increment uses an explicit
export adapter of the same frozen source SHA. No Core modifications, new runtime
dependencies, real GitHub assignments or Host installation are implied.

## Group membership and reporter preference — 2026-10-20

Source: `thread_mucwsgsjtlbabfcq#0001792510714026-000073-37b4fb6b`.
This plugin-only increment adds an explicit staff roster, member-reporter priority,
one-time owner assignment and reporter acceptance recommendations. Group membership
is independent of repository access and routing rules, and is refreshed before
writes, retries and intake. Existing different assignees are preserved.

The 38 team checks and packed team browser journey passed. The latter covers
selection, confirmation, persisted result/reload, feedback and uncertain-publication
recovery. Desktop and 390px confirmation screenshots were inspected. The complete
35-step repository gate and all five packed browser/READ journeys passed; the
managed command exited 0, and all 109 captured source digests still matched on
readback. The existing Feishu pack exemption is unchanged. See
[`docs/evidence/issue-workbench-group.md`](../../docs/evidence/issue-workbench-group.md)
for observed failures/fixes, exact commands and remaining real-journey gaps.
No production group, real GitHub assignment/comment, Host change, merge or
independent approval is implied by these isolated checks.

## Team workbench and recovery — 2026-10-20

Accepted source: `thread_mucwsgsjtlbabfcq#0001792487469228-000178-8c6b1ebb`.
The candidate now connects the existing three-column workbench to owner-authenticated
analysis requests, cat results, feedback and a team-record drawer. Native cat
identity and Settings authority remain separate. Statistics expose category,
score and historical assignment counts; they do not represent model training.

Observed RED→GREEN: missing owner handlers/withdrawal notice; same-assignment reopen
remaining inactive; missing analysis button; receipt recovery absent from the inbox
detail. The existing mobile journey also caught the source-settings panel hiding its
own toggle when the new toolbar wrapped; it now follows the actual header height.
Core export: `031244712b8b62d1dc017ed379efd09b15dd4fc6`.

The 22 team behavior checks and packed browser journeys cover owner request/result/
feedback, permission withdrawal clearing displayed data, explicit uncertain-comment
republication, stale source, mobile/dark layout, durable withdrawal/reopen and
restart deduplication. Actual Host carrier checks use isolated inventory/config
and explicit test authority: admission, Settings health/summary, rejection without
publication confirmation, real GitHub READ, disable/refusal and re-enable.

Full user journey remains incomplete at installed Host UI, live cat invocation and
real two-account verification. The ordinary READ preview shows a disconnected team
state. No production config, real assignment/comment or catalog publication changed.
See `docs/evidence/issue-workbench-team-candidate.md` for current evidence and limits.

## Classification overview wording — 2026-10-20

Source: `thread_mucwsgsjtlbabfcq#0001792486161119-000170-f4dd06d2`.
The operator considers **随 Feature 处理** a classification and does not need
a classification-result total. The entry and heading now say **分类结果** without
a headline count. The overview description includes issue categories and Feature
groups; per-category counts, filtering and pagination remain available.
Feature-bound issue notes describe their existing classification.

The existing packed browser journey reproduced an incorrect empty-results message
when all semantic suggestions were replaced by Feature bindings. It now passes:
both Feature-classified issues remain browsable without an empty-results message,
and access withdrawal still removes their source content. No classification corpus,
source labels, authored records, API or permission changes.
Core export: `afa6e76ae9f0e34878100aa8d0627e540be0f642`.
Final validation and live-preview evidence: `artifacts/classification-copy-2026-10-20/`.
PR #80 remains open and unmerged.

## Main compatibility update — 2026-10-20

The PR conflict notification was verified against GitHub and a local merge of
`29595a7794486ed0e6354a35a706875998e23d8f` into this feature branch. Conflicts were
limited to Contract CI and the workspace lockfile. Main's shared `gate:ci` entry
is retained; the workbench's manifest/lint/tests/build/artifact checks now join
that shared gate, and its packed browser journey remains explicit in the workflow.
A regression check first failed with the workbench gate absent, then passed after
integration (12 CI-gate checks). Main's 24 existing lockfile importers, 392 package
records and 395 resolved snapshots are preserved; only the workbench dependency
closure is added. Frozen installation is part of the full gate.

This synchronization does not modify the workbench UI, classification corpus or
service behavior. Validation logs and final-head evidence are retained under
`artifacts/main-sync-2026-10-20/`. The source export still uses Core cut
`3432e6d0b00749d762a8e2ec441c4f6a33fa241a`. This is PR maintenance, not a merge
to main, publication, approval or completion of the overall plugin feature.

## Visible Open / Closed distinction — 2026-10-20

Source: `thread_mucwsgsjtlbabfcq#0001792479863843-000114-15c85d76`.
Source state previously appeared as muted text. A shared icon/text badge now shows
green **Open · 开放** and purple **Closed · 已关闭** in multi-source queues,
classification cards and reading headers, plus the original single-source
list/detail. Unknown and unavailable sources use neutral labels. Light/dark
styles retain the text/icon distinction instead of relying on color alone.

Queue **全部 / Open / Closed** buttons show counts within the category/source/search
scope; **其他状态** appears for unknown/unavailable records. State switches select
a matching issue while retaining per-issue drafts. **本仓** verification stays
separate; source closure does not mark a local fix verified.

The packed browser journey first failed waiting for the missing Closed badge.
It then passed with distinct computed colors, Open/Closed filtering and counts,
matching detail state, draft retention, classification badges and neutral
unknown/unavailable handling. Existing fuzzy-linking, save/reload, grant withdrawal
and mobile journeys remain covered. Build/typecheck/export checks and the 5 sync,
19 source/port, 15 UI and corpus tests passed; the legacy refresh test now checks
the new Closed label while preserving its unsaved-input/local-acceptance assertions.

Real-page inspection caught an overflowing Closed count in the 270px desktop
queue: the shell's generic button reset overrode compact filter typography.
An overflow assertion reproduced it RED; scoped selector specificity and
content-sized, wrapping buttons prevent both style overrides and count overflow.

Core cut: `3432e6d0b00749d762a8e2ec441c4f6a33fa241a`.
Package export explicitly includes the shared badge/filter component and stylesheet.
The classification dataset, service/store contract and remote issue state are not
changed by this UI increment. Final packed preview screenshots and local-record
preservation evidence are recorded under `artifacts/source-state-2026-10-20/`.
PR #80 remains open for independent review; this is author validation only.
The fallback scanner's three new flags are Boolean membership/display predicates
in `IssueSourceState`, not alternative data paths; the only state source remains
the imported fact. No store/transport/architecture ownership changes. Capability
tips checks passed with existing anchor warnings; the opt-in preview's state
controls are self-describing and retain the existing `tips_exempt` scope.

## First full classification and category browsing — 2026-10-20

Accepted source: `thread_mucwsgsjtlbabfcq#0001792467519190-000035-6016964e`;
implementation reassigned to 砚砚 by `0001792468889994-000066-b4e4fc29`.
The operator asked for current issues, a first classification visible by category,
and existing Feature bindings to take precedence. PR #80 remains open; no merge.

- Fresh public catalog at **04:03 UTC**: **813** issues, **288 open / 525 closed**.
  All **708 unbound titles** received one primary proposal, including **4 待澄清**.
  **105 issues / 32 explicit Features** remain Feature-routed. Full source metadata,
  labels, body hashes, taxonomy and the unaccepted proposals ship in
  `data/first-classification.v1.json`; the historical twelve-result seed is unchanged.
- Method: GPT-6-astra title-first semantic review, selected ambiguous body reads.
  Comments were not reviewed. Type/environment supplement explicit source/title
  markers; symptom remains empty. No trained model, automated continuous classifier,
  measured accuracy, confidence scores or automatic acceptance is claimed.
- Queue **按类别查看** and overview category counts/search/state filters expose the
  results. **随 Feature 处理** opens Feature subgroups; title references and bare
  `feature` do not bind. The overview pages 40 cards at a time. Adding a source
  Feature label suppresses an older candidate on refresh, without deleting local work.
- The isolated example Host now uses the exported paginated READ engine and the
  canonical `gh` CLI (fixed `github.com` and repository) instead of expired port 3192.
  Cache/detail archives remain within its explicitly supplied isolated dataRoot.
  No production configuration, remote labels, SDK contract or runtime dependency changed.

Verification:

- Core Feature-precedence regression observed RED, then GREEN; UI category journey
  likewise failed on the missing category control before export, then passed.
- Build, TypeScript, boundary/export hash checks; **5 sync + 19 source/port +
  15 UI + 1 corpus integrity** tests passed.
- Actual packed tgz: three browser journeys and a clean consumer passed.
  They cover category/Feature filtering, mixed-case and multiple bindings, generic
  feature handling, refresh withdrawal, manual tag preservation, explicit save/reload,
  source revocation, mobile layout, existing fuzzy linking and source detail paging.
- A new public READ Host test verifies cold load, cache after restart, refresh,
  immutable comment page continuation and explicit isolated storage.
- Real-data dogfood used `http://localhost:5196` from the packed preview in
  `/Users/yuki/.cat-cafe/preview-builds/issue-coordination-v1`. It read **813 public +
  2 clearly marked synthetic** issues; checked every primary category count,
  opened **F113**'s 12 issues with no semantic candidate cards, searched **#1591**,
  fetched its actual body, and checked desktop 1440px / mobile 390px rendering.
  Zero page errors or horizontal mobile overflow. Evidence:
  `artifacts/classification-2026-10-20/live-journey.json` and screenshots in that folder.
  Synthetic persistence tests use disposable stores; live dogfood does not save notes.
- Before restarting the expired preview, its recorded data directory
  `/Users/yuki/.cat-cafe/preview-data/issue-coordination-v1` did not exist.
  No old-note recovery or before/after preservation claim is made for that missing
  directory. Other origins and stores were not migrated or modified.

Ownership: existing Issue workbench model/UI/read-source cell, no map expansion.
Core export is pinned to `21c6f12e9bcc3d1308f92d0b2584835b1071eb5b`.
Package data and acceptance Host remain plugin-owned.
Core capability-tip checks passed with existing unrelated anchor warnings.
The architecture-ownership command is absent in this checkout, not recorded as
passed. The fallback scan covers the entire historical branch and flags logical
predicates/sort tie-breakers as well as recovery. The new grouping helpers add a
counter initialization, a deterministic tie-breaker and a Feature/unavailable
predicate, not chained fallback tiers. The Host has a single persisted-cache read
and explicit refresh path; it removes the dependency on a second preview server.
`tips_exempt: Pre-SDK standalone package; its entry/action is documented in this package README, not registered in the Core capability-tip catalog.`
This is author validation. The latest independent review remains outstanding and
historical approvals do not cover this head; production install/cutover is still open.

## Visible classification results — 2026-10-14 (historical)

Core export: `5517539aa1e80a789775c470c2517486150a9d5d`.
Accepted source: `thread_mucwsgsjtlbabfcq#0001791981133558-000152-e727fe85`:
the operator could not see the classification results and asked for the dataset
beside the plugin code. The immutable 12-result JSON now ships in `data/`, not
`docs/evidence`; the plan holds method/future work, not a duplicate sample table.
Gemini's current design is source `0001791981588832-000167-ea9eabec`.

Journey: header **分类结果** (or `?classifications=1`) → overview of all readable
candidates with four facets/excerpts/model/date → select issue → inspect candidate
beside the original body → append to local tag draft → explicitly save → reload.
The desktop drawer uses two columns for comparison, mobile one column; this widens
Gemini's narrow drawer without changing its overview/issue/adoption sequence.
Empty facets say not extracted; no fabricated scope/severity/confidence is shown.

Author validation: service test observed RED without results, then GREEN with full
provider/instance/repository/issue identity and per-load grant filtering. The packed
browser test observed RED without the overview, then GREEN across entry, evidence,
stale timestamp notice, preservation of manual tags, no write before save, persisted
reload, mobile selection, Escape, and disappearance after grant withdrawal. The tgz
consumer asserts the 12 unaccepted proposals ship with the package. The browser
bundle does not embed the public seed; only the example Host loads it.

Build and typecheck/export-boundary lint passed. Five sync, 19 source/port and 15
existing UI tests passed; all three packed browser journeys and the clean Node
consumer passed. Exact Core export check reports `changed: []`. Real public-data
dogfood rendered 12 results across 799 readable issues, selected #1591, loaded its
body and checked its installation/build + plugin classification at 1440 and 390px.
Desktop/mobile/dark screenshots were inspected; no page errors or horizontal
mobile overflow, no local work writes or remote mutations. Evidence is in ignored
`artifacts/classification-live-*`; synthetic save/reload uses a temporary store.

Risk: new candidate display and explicit draft action; no store migration, remote
write, grant policy, production configuration, external dependency or SDK change.
Ownership stays in the existing Core business/UI export and Plugins Host/package.
Architecture checker remains unavailable (missing script); capability-tips passed
with existing unrelated anchor warnings. Fallback scan's new nullish cases are
empty optional result collections / absent cached catalog / absent facet text;
they preserve one source of truth and add no new recovery path. Existing grant and
cached-read checks remain intact. No root media artifacts were added.

This fixes visible delivery of the initial sample, not full-corpus model generation,
accuracy validation, structured acceptance/rejection history or installed-plugin
acceptance. The broader feature and PR remain open. This is author evidence; no new
independent approval, merge or release is claimed.

## Related-issue search — 2026-10-14

Core export: `2408d14ac01714dbe1be3641ea7a3a70223e4158`.
Operator request: `thread_mucwsgsjtlbabfcq#0001791979112333-000149-a8f89545`.
Replace the unsearchable related-issue select with a searchable combobox. Partial
text matching covers title, source name and issue number; space-separated terms
must all match. Matching normalizes character width/case and ranks exact numbers
before partial numbers. This is local text filtering, not semantic similarity or
typo correction. Search covers all currently readable candidates, while the list
renders at most 30 with an explicit count/narrow-query hint. Current issue is excluded.

The full source/issue identity remains the saved target. Editing the input clears
the prior choice; no arbitrary text can become a relation. Results show source,
number and title; arrows/Enter select, Escape closes, and clear resets the query.
IME confirmation cannot select or submit. Revocation removes the choice and label;
restoring access does not silently reinstate it. Relation persistence and existing
source permissions are unchanged; no new dependency or remote search is added.

RED: the new packed browser journey failed because the old select was not editable.
A second regression reproduced automatic reselection after grant restoration;
clearing an inaccessible selection fixes it. GREEN: the packed journey now uses
803 synthetic issues, finds an item beyond the initial result window, tests multiword
and number/source queries, exact-number ordering, same-number isolation, keyboard,
IME, empty results, clear, save/reload and revoke/restore. Mobile dark rendering was
inspected with no horizontal overflow. Build, typecheck/boundary/hash lint, five
sync tests, exact Core export (`changed: []`), both packed browser journeys and the
clean Node consumer passed. Unchanged source/model unit evidence remains historical.

Ownership stays in the existing Core UI export; Plugins owns the consumer journey
and export mapping. Fallback scanner flags keyboard OR/else-if predicates and the
clear-button visibility condition, not recovery layers or alternate sources.
This is author validation for the same open PR, with no merge or release.

## Layout increment — 2026-10-14

Core export: `e562a37b517deb56c958926f5cae39ed6070efaa`.
PR #80 remains an open development PR; the operator explicitly asked for updates
without merging. The wider installed-plugin and cat-dispatch journey is still open.

The operator reported that the multi-source layout buried the actual work. Gemini's
layout proposal (`thread_mucwsgsjtlbabfcq#0001791977175417-000134-05d89882`)
is implemented as a compact header, queue, independently scrolling reading pane,
and persistent investigation/save pane. At 1050px, reading/investigation switch
beside the queue; at 390px, queue/reading/investigation switch within one viewport.
Drafts survive these switches and the investigation view retains the issue identity.
Source settings are grouped in an expandable panel; errors and synthetic-source
identification stay visible. Comments and secondary evidence fields start folded.
Markdown reuses the existing DOMPurify/URL-validation renderer.

Design adjustments: use the existing semantic controls and source selector; do not
add decorative badges, invented confidence percentages, unimplemented shortcuts or
nonfunctional candidate-adoption buttons. The label seed remains a separate proposal;
model-generated suggestions and accept/reject persistence are not implemented.

Author journey: the packed package configures a source, opens a long Markdown issue,
keeps the save action inside the first viewport, saves evidence, links issues,
reloads, switches between issues/views without losing drafts, then handles one
source failing and its grant being revoked. Source closure and local verification
remain independent. A malicious Markdown event handler does not execute. Desktop,
1050px, mobile and dark screenshots were inspected. The follow-up check also verifies
that mobile settings fit the viewport and notes retain source/number/title.
The new Markdown heading assertion was observed red against the prior artifact;
it now passes. No page errors or horizontal viewport overflow were observed.

Checks this increment: build, typecheck/boundary/hash lint, 5 sync + 18 source/port +
15 existing UI cases, both packed browser journeys and the clean Node consumer all
passed. After the mobile identity/settings adjustment, affected browser/artifact
checks, build/lint and exact Core export check passed again (`changed: []`).
Screenshots are generated under ignored `artifacts/coordination-*`.

Risk: presentation/navigation and safe text rendering; no store schema, permission,
Host port, external dependency or source-platform write changes. Ownership remains
Core business/UI export and Plugins packaging/acceptance Host; architecture map
change: none. The Core ownership checker is unavailable in this checkout (missing
script), not a passing check. Capability-tips check passed with 17 unrelated existing
anchor warnings. Fallback scan flags nullable presentation values (missing body,
base URL, loaded-comment count): these are empty-state defaults within the same
source response, not alternate data sources or layered recovery. Authorization and
request-generation guards are unchanged. No root media artifacts were added.

This is author validation, not a new independent approval. Earlier approval of
`dfd0161d` does not cover this increment. No merge or release was performed.

## Multi-source increment — 2026-10-14

Historical Core export: `228630decccdbbb7e33db159947d924d51074c16`.
The original single-source validation below is historical. New checks run for this
increment: typecheck/boundary/hash lint, 5 sync + 18 source/port + 15 existing UI
cases, manifest validation, and the actual packed multi-source browser journey.
The existing packed single-source browser and clean Node consumer also passed.

The new journey configures a source branch, edits and saves, rejects verification
without evidence, switches without losing drafts, updates without changing drafts,
manually links two issues, reloads, and observes upstream passed/internal pending.
It then fails one source and revokes that source: authorized old data survives
network failure; revoked content and shared relation conclusions disappear.
Foreign Origin and headerless POST are rejected by the isolated example Host.
Screenshots are kept in ignored package `artifacts/coordination-*`.

The store test was observed red before durable persistence, then green after atomic
replacement/revision locking. The orphan-work assertion was observed red when both
live and cached catalogs failed, then green after separating unavailable data from
revoked access. Browser labels failed when restored textarea content entered the
implicit accessible name; explicit labels corrected the real packed journey.
An additional rendered-DOM assertion reproduced duplicate reading panels after
navigation (18 instead of 1): sibling reading and relation views had the same React
key. Distinct prefixes fix the reconciliation failure; the regression is retained.

Risk: authored local data and application ports changed; no SDK/contract, production
data, remote issue write or automatic task dispatch changed. Business implementation
is exported from Core; package mounting, same-origin transport and acceptance Host
remain Plugins-owned. Internal adapters and fixed-SDK installation are not proven.
New local records are stored in the explicitly isolated Host directory. Existing
single-source browser records and label batches remain at their original entry.

This is author validation for an unmerged development trial; it is not a release or
independent reviewer approval. Real internal acceptance awaits its API/repository.

Validated 2026-10-14 on macOS arm64. Scope: independent pre-SDK package and
repeatable extraction. This does not claim Plugin Manager installation, official
release, migration of real user data or real cat dispatch.

Source: Core feature commit `3aca4242a03081edbfae32b8f34e316f845d5daf`.
Public base: Plugins `47071ae07ca054b4fb0b8b3f523d890381df4bfd`.
These are distinct repositories. The source commit may not be reachable from public
Core main; `sync-state.json` binds the local source cut and file hashes. Public CI
verifies exported hashes; the source-side check was also run against that commit.

## Results

| Check | Result |
| --- | --- |
| Artifact toolchain verifier | Node 24.18.0 / npm 11.16.0 / zlib 1.3.1-e00f703 |
| Frozen-lockfile dependency installation | Passed; no existing lock entries changed |
| `check:manifest` | Candidate accepted by the current public manifest validator |
| `lint` | Typecheck, source receipt and no private Core imports passed |
| `test:sync` | 5 passed: exact cut, idempotence, dirty/conflicting input, complete preflight and dangling symlinks |
| `test:source` | 16 passed: catalog/detail/archive, partial failure, races, source edits and repository/owner ports |
| `test:ui` | 15 passed: existing model, source refresh, discussion/loading and race behavior |
| `build` | Standalone Node/browser entries, CSS, declarations, demo and complete bundled licenses |
| `test:artifact` | Passed: actual tgz installed outside the monorepo, public exports and restart persistence, no runtime dependencies |
| `test:browser` | Passed: actual tgz, system Chrome, desktop 1440 and mobile 390; no page errors or external requests |
| Core export `--check` | Exact source commit, `changed: []` |
| Contract `generate:check` / build | Passed |
| Contract conformance | 34/34 fixtures and 18/18 behavior cases |
| `git diff --check` | Passed |

Run the commands in README to reproduce. The test process sets NODE_ENV=test
explicitly so an embedding shell's production value cannot disable React act.
For a preinstalled browser, set PLAYWRIGHT_CHROMIUM_EXECUTABLE to its executable;
CI installs the pinned Playwright Chromium build.

## Actual packed journey

The browser test starts a temporary loopback server from the extracted tgz and
uses synthetic observations only. It reads body → loads comments 25/37 to 37/37 →
saves a solution → reloads and recovers it → edits without saving → cancels disable
and keeps that edit → opens the mobile detail without horizontal overflow.
Screenshots are generated in ignored `artifacts/packed-{desktop,mobile}.png` and
were inspected locally. No runtime service or real user store was used.

The Node consumer separately writes source observations, constructs a fresh store
and recovers the archived Markdown while the catalog stays light. Failure/race
cases are covered in source and UI tests; the demo does not claim live GitHub.

The sync failure regression was observed before the fix: existsSync missed dangling
symlinks, allowing replacement. lstat now rejects them before any export writes.
An additional test proves a later transform failure leaves all earlier output and
the old receipt unchanged. Browser test locators use the actual tab roles.

## Review and delivery boundary

Architecture ownership: Issue business/model/UI move into the standalone package;
Core authorization, routes and lifecycle stay in Core. Transitional ports are
explicit application interfaces, not a new public SDK or permission bypass.
Risk checks cover behavior, retained synthetic source data, repository/owner
isolation, import/manifest/artifact contracts and deterministic export. This PR
changes no production data, automatic release workflow or catalog entry.

Three Host-only route/authorization tests and one plugin-directory shell test stay
in Core; they were not represented as package tests. Real installed lifecycle,
retained user-work migration and cat task/result/acceptance remain in the broader
implementation plan. No independent reviewer approval or CI completion is implied
by this author validation record. The PR touches protected lockfile/workflow paths
and therefore requires the repository's other-party CODEOWNER approval on the
final push, plus required Typecheck + Conformance CI, before merge.

Final tgz filename/size/integrity are recorded in the PR after this document is
included in the pack, avoiding a self-referential package hash.

## GitHub invitation delta (2026-10-21)

65 team checks and both packed team browser journeys pass, including a READ sender,
a separate receiving Host store, restart deduplication and an explicitly authored
acceptance report displayed back at the sender. Existing assignee mutation retains
its own confirmation. Evidence and known installed-Host gap are recorded in
`docs/evidence/issue-workbench-github-invitations.md` in the repository.
The full repository gate is separately recorded in
`artifacts/github-delivery-2026-10-21/verification.json`; no real GitHub messages,
production configuration changes or installed lifecycle completion are implied.
