# Issue Workbench — standalone workbench and SDK candidate

[Chinese guide](README.md)

## Classification, assignment and acceptance

The installed workbench is served by this package through the existing authenticated
Host route `/api/plugins/dev.clowder.issue-workbench/workbench/installed.html`.
Its human edits, history, categories and assignment rules share one durable plugin
store. Human categories take precedence over later cat suggestions. The old
standalone preview store is not silently migrated.

`initialClassification` opts into one initial batch covering both Open and Closed
history, excluding pull requests. Configured cat/thread routing and the complete
catalog are required. Restart continues the same batch. `automaticAssignment` is
independent: it scans unassigned Open Issues and can use saved human categories
without another model call. Member authors take precedence, followed by Feature
rules and category rules. At most ten actionable records advance per sweep;
unmatched entries do not starve later matches. Paused/stopped analysis batches retain
their dispatch fences. Closed Issues are classified but never auto-assigned.

In `团队记录 → 我的收件`, the receiving owner can choose `接下此任务`.
Acceptance persists locally. `复制开工指令` and `打开收件对话` provide the
exact Issue/receipt context for an explicit user message in the original thread.
The cat admits or resumes work from that message; a plugin acceptance or notification
does not manufacture execution authority. Public reports still require `shareProgress`.

These paths pass isolated tests using real Host implementation and packed browser
assets. Default Host grants remain absent, so active-café authorization, real cat
execution and two-account acceptance remain unverified; `hostInstallable` stays false.

A standalone extraction of the existing Clowder Issue workbench. It reads GitHub
observations, keeps versioned Markdown archives, and provides a browser workbench
for local annotations, solutions, evidence and task/label drafts.

**Status:** this alpha builds, packs and runs independently of the Core checkout.
The canonical `plugin.yaml` lets Plugin Manager admit the exact package. The
current Host's default policy grants this plugin **no capabilities**, so admission
does not make it usable in the running café. `integration.json` retains
`hostInstallable:false` until the full installed journey is accepted. The package
is absent from the public catalog and automatic npm publishing.

To verify the existing functionality without editing Host code, run the isolated
[Host integration test](HOST-TESTING.md). It uses real Host installation, lifecycle,
configuration, operation authorization, messaging and Redis storage, with explicit
test grants and fixtures for GitHub, login and model invocation. This is distinct
from production authorization and real two-account acceptance.

### Team module candidate

For hands-on workflow testing, use the [interactive isolated sandbox](SANDBOX.md)
from this repository. It keeps the packed workbench running with two simulated
accounts, durable plans and receipts, and explicit success/failure/waiting controls.
Host grants, login, model outcomes and GitHub transport remain test substitutes;
the running production Host is unchanged.

`dist/team-plugin.js` uses the public SDK `0.2.0-beta.21` and installation-scoped
Host storage, current invocation identity, thread visibility and message delivery.
Its nine `issue_team_*` actions support reading an Issue, requesting analysis by an
explicitly configured cat, submitting evidence-backed classifications/priority,
configured automatic GitHub assignment, startup inbox recovery, progress reports,
explicit feedback and statistics. The three-column workbench now includes a team
analysis panel and a `团队记录` drawer for inbox, analysis history and feedback.
It can request analysis, read scores/evidence/current assignees, save owner feedback
and recover uncertain publications through the Host's owner-operation route.
The standalone READ preview shows an honest disconnected state until an embedding
Host provides that authorized route; opening the preview does not install a module.

Open an Issue and choose its `研判方式`:

- `人工研判` (initial view): read existing automatic classification and evidence first.
  Expand `调整分类（可选）` or `补充分析（可选）` only when needed, then click
  `保存分析`. New correction drafts use the automatic result; existing manual records
  remain intact. Local repair, branch and verification forms are no longer part of this flow.
- `猫猫研判`: choose `分析猫猫` from this café's configured Host members,
  then click `请猫分析`. The list includes members not yet in the configured
  analysis thread; unavailable members remain visible but cannot receive a task.
  Changing mode or selecting a name does not send anything or discard manual drafts.

The cat roster comes from the Host; GitHub Organization members are a separate
list for assigning people. Refresh never silently replaces a selected cat. The
Host checks the destination again when sending. If that cat becomes unavailable,
wait for recovery or explicitly choose another member. The standalone READ preview
cannot enumerate or invoke real cats until its authorized Host route is connected.
The view starts in manual mode after reload; saved local work remains available.

For a batch, open `团队记录 → 自动研判`, choose a repository and a configured
cat, then `读取待研判问题`. This reads every Open Issue page (excluding PRs)
and persists a paused queue; it does not call a cat. Review the count and the
displayed automatic-assignment setting, then `启动队列`. The Host processes one
outstanding analysis per queue and resumes persisted requests after restart without
duplicating their delivery. The batch contains the issues observed when prepared;
newly opened issues require a new batch, not an implied continuous watch.

`暂停队列` keeps outstanding results but prevents new analysis delivery and
automatic assignment. `停止队列` ends that batch; prepare another to restart.
Completed analysis still permits recovery of its pending automatic assignments;
`停止后续派工` ends those retries too. Closing the drawer or changing the
single-issue analysis mode does not stop an explicitly started batch. The selected
cat/thread never silently changes. Source changes and unavailable routes remain
visible for inspection. Closed issues are skipped before analysis. `研判记录`
shows each result and its separate assignment state; completed classification does
not mean assigned, accepted or repaired. This path needs the same authorized Host
connection as single-issue cat analysis; it is not available in a READ-only preview.

For source configuration, open `管理来源` in the header. Enable an already bound
repository and set its display name. Existing branch/baseline values are preserved
without requiring them in the analysis workflow. Repository connections are supplied by the Host. This
preview does not yet provide a form to add a repository or configure the team module.

Set **teamOrganization** to a GitHub Organization name or profile URL, for example
`meow-club` or `https://github.com/meow-club`. The plugin reads its current members
through the local authenticated `gh` CLI, including all result pages. The signed-in
account must be an active organization member with organization-member read access
(classic/OAuth `read:org`, or fine-grained **Members: read**). No new credential is
stored in plugin settings. This links the whole Organization, not a GitHub Team.

The team panel shows the organization and member count. `团队记录 → 刷新组织成员`
reloads the roster and displays member profile links. Public-only visibility, failed
reads and incomplete pages never become an authoritative roster; analysis/history
remain available, with an actionable error and refresh. Members are re-read before
assignment, publication and intake, and repository assignability is checked separately.

Migration: `teamGroupName` / `teamMembers` are no longer used as membership authority.
Configure the organization once; old records and settings data are not deleted.
Missing configuration never falls back to the old list. Repository collaborators,
routing-rule entries and Issue prose cannot add organization members. Pending
assignment intent bound to the old policy requires a fresh analysis/confirmation.

A member who opened an Issue is the first assignment choice. The author comes
from GitHub's `user.login`, never a mention in the Issue body. Other Issues use
Feature rules before category rules, restricted to current group members.
Feature classification remains visible even when its member reporter is preferred.
Existing different assignees, changed source text and ambiguous rules stop automatic
assignment. The owner can select a group member in the analysis panel and confirm
one assignment without enabling automatic assignment. Confirmation binds the
current record revision and publishes the score/reason; stale clicks cannot replay it.
Alternatively, **automaticAssignment** explicitly enables the saved routing policy.
Membership, repository permission and request authority are checked before writes
and retries. A failed one-time assignment does not authorize a background retry.

The receiving member uses their own GitHub CLI account and configures their own
**inboxThreadId** / **inboxCatId**. Their plugin must enable **receiveAssignments**
and connect the same organization; that account must be one of its active members. The sender does not guess a remote
cat identity. For member-authored Issues, the workbench, dispatch comment and
receiving cat's notice suggest inviting the reporter to acceptance before merge.
This is a recommendation, not a merge gate or an acceptance result. Reports require
the currently assigned group member and a separate **shareProgress** setting.

Source fingerprints now include the provider-verified author. Older analysis
records are retained but require a fresh analysis before new assignment; historical
dispatch markers remain readable. Removing someone from the group stops future
writes and intake, without deleting history or automatically unassigning GitHub work.

Initial startup includes previously assigned Open Issues. Provider assignment
event IDs distinguish reassignment from restart. A durable Host message ID means
delivered, not accepted or executing. Receiver-authored progress is not a Host
execution verdict. Unknown comment publication outcomes are not retried with a
blind POST. The owner can check the original issue and explicitly confirm another
publication against the current record revision; this never changes the assignee.
Closing/reassigning sends a durable change notice to the original destination;
reopening resumes delivery without treating it as a restart duplicate.
Analysis/feedback counts are descriptive statistics, not trained
weights, measured classifier accuracy or automatic human acceptance.

The source of this new extension is `src/team/`, owned by the plugin. The Core
export is pinned to `031244712b8b62d1dc017ed379efd09b15dd4fc6`; its generic extension slots
keep team policy and UI in this plugin. See [the implementation plan](../../docs/plans/issue-workbench-team.md).
Remaining acceptance: compatible installed Host and workbench surface, lifecycle
and grants, safe migration, and two real accounts/teams. Core main
`c086765ddb7181722f03f9f53c7a7ee17a29f147` supports public modules and the matching
SDK. [Core companion #1639](https://github.com/zts212653/clowder-ai/pull/1639)
was withdrawn on 2026-10-20 at the owner's request: its Issue-specific grant policy,
tests and acceptance script were reverted, and the PR was closed without merging.
Earlier isolated Host checks used that withdrawn policy and are historical evidence,
not proof of current installation or grants. Development is limited to plugin PR #80;
the team integration must be reassessed against existing public Host capabilities
and supported installation authorization. User installation, live-cat invocation
and the remaining product journey are still pending; `hostInstallable` remains false.

### Embedding the team workbench

Use the Host's authenticated request function; the browser never supplies caller
identity or saved assignment policy:

```ts
import { createTeamClient, mountCoordination } from '@clowder-ai/issue-workbench/browser';
const team = createTeamClient(hostRequest, pluginSettingsUrl);
mountCoordination(element, coordinationHost, { team });
```

The client uses the existing `/api/plugins/dev.clowder.issue-workbench/actions/teamWorkbench/*`
owner route. Install/configure the module and grant its declared capabilities in
the Host first. Settings **analysisThreadId** selects the owner-request thread and
**analysisCatId** supplies its default cat. The issue panel lists that thread's
Host-routable cats (including those not yet joined); an owner can select the target
for one request. This is a destination, never a caller identity. Native conversation
requests retain their calling thread and configured cat.
Unsaved form values never become effective routing policy. The optional preview
`teamAction` callback is an isolated test seam, not an authentication mechanism.
Statistics count recorded analyses, explicit latest feedback, score/category
frequency and historical published assignments by member, not current workload.

Opening an issue automatically shows its existing classification and loads the
organization members. Assignment no longer requires an analysis: select a member,
then confirm. Direct assignment is recorded separately, publishes no invented score,
and does not count as a cat analysis. `请猫分析` sends the selected cat a classification
and rule-limited assignment task. Results refresh automatically while a request is
pending. If automatic assignment is disabled, the task recommends a member for owner
confirmation; it cannot bypass that setting. Viewing a page alone never wakes a cat
or writes GitHub. New issues without existing classification remain `尚未分类` until
analysis returns; Feature bindings retain precedence. Persisted results feed the queue,
category filters and detail together, fenced by source identity and provider update
stamp; source labels and authored local records are not overwritten.

## What is in the artifact

### Multi-source investigation (pre-SDK)

`mountCoordination(element, host)` adds an aggregate lightweight queue, independently
configured source preferences, manual issue relations and per-repository analysis
records. Classification results are displayed first; optional corrections and notes
support assignment. Historical repair fields remain readable and are preserved.
Source state and local analysis stay separate. There are no automatic remote writes, model
requests, code merges or cat dispatches. Internal evidence is not copied into public
tasks. Source prose is shown as text without fetching remote images.

`IssueCoordinationService` takes approved bindings (stable provider-instance/repository
identity, current grant callback, catalog and detail readers) and an owner-specific
`IssueCoordinationStore`. The same stable IDs must survive renames and credential
rotation. Do not share storage roots between tenants or cache roots across effective
authorization scopes. Every binding must recheck current grants, including cached
reads. Internal adapters must supply stable issue IDs and complete/partial read facts;
a GitHub-like interface does not prove GitHub API compatibility.

For a synthetic local trial after `pnpm build`:

```sh
ISSUE_COORDINATION_DATA_DIR=/absolute/isolated/issue-coordination PORT=5196 pnpm preview:coordination
```

Open `http://localhost:5196`. Manage the two clearly marked synthetic sources, select
an issue, inspect its classification, optionally save a correction or analysis note,
and link its counterpart. Reload to recover the saved work. The supplied loopback Host
is for acceptance only; production installation must provide real owner authorization.
Its source registry is supplied by the Host, not an arbitrary URL/token form.

`ISSUE_COORDINATION_GITHUB=1` explicitly replaces the public fixture with a
GitHub READ adapter for `zts212653/clowder-ai`. The example Host invokes the
authenticated `gh` on its PATH using the exported paginated source engine, and
stores its cache under the dedicated data directory. It no longer needs port 3192.
It does not connect an internal service. The `?legacy=1` trial link exposes the original
5192 workbench; old browser plans and label batches stay there, untouched. SDK cutover
must include an explicit data migration; it is not performed by this increment.

### Inspect initial classifications

Source status is visible on each queue row, classification card and issue detail:
`green Open · 开放`, `purple Closed · 已关闭`, each with a distinct icon and
text. Unknown/unavailable sources have neutral labels. The single-source view uses
the same badges. In the multi-source queue, `全部 / Open / Closed` filters include
counts within the current category, source and search; `其他状态` appears when
needed. Switching state preserves investigation drafts.
These are source-platform states. A Closed issue does not imply that a local analysis
or assignment is complete. This workbench does not manage local repairs.

Use `按类别查看` in the issue queue, or click `分类结果` in the GitHub preview header. Open
`http://localhost:5196/?legacy=1&classifications=1` to show the overview immediately.
The first full pass observed **813 issues: 288 open, 525 closed** on 2026-10-20.
**105 already bound to 32 Features** stay with those Features; **708** have a
primary classification (including four insufficient-information items in `待澄清`).
The overview shows category counts, title/number search, open/closed filters and
Feature subgroups. It initially renders 40 results; `显示更多问题` loads the next
40 from the same filtered set. Selecting a category in the queue opens its first issue.
Select an issue to read its automatic classification and evidence immediately.
Only open `调整分类（可选）` and click `保存分析` when correcting it.
No copy-to-draft step or repair form is required. Existing manual tags and historical
repair records remain intact; reading a result does not save or write to GitHub.

The active public dataset lives in [data/first-classification.v1.json](data/first-classification.v1.json),
ships inside the tgz and is loaded by the example Host only for the matching public
repository. Other Host bindings may supply `classifications`; results must match
provider, instance, stable repository ID and a currently readable issue. Revoked
sources and their derived suggestions are hidden. A changed source timestamp flags
review; this is not continuous content-hash verification. Exact `feature:F<number>`
source labels take precedence on every read, including a binding added after this
batch. Bare `feature` labels and Feature numbers in titles are not bindings.
Existing local work remains intact. New unbound issues show `尚未分类`.
The browser bundle does
not embed the seed. Hosts can pass `{ showClassifications: true }` as the optional
third argument to `mountCoordination` for this entry.

This is GPT-6-astra's first semantic pass over all unbound titles, with selected
ambiguous bodies consulted. Type/environment facets use explicit source labels or
title markers; symptoms were not extracted in this pass. It is not a trained or
continuously automatic classifier and has no measured accuracy or preaccepted labels.
The historical 12-result `initial-classification.v0.json` stays unchanged.
Empty facets mean no evidence was extracted. The default synthetic trial
has no classifications; it does not impersonate these real public results.

Run `pnpm test:coordination` for the actual packed artifact browser journey. As with
`test:browser`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an installed Chrome.


- `dist/index.js`: source reader (injected `GhQuery`), refresh service, durable
  source archive store, model and label-draft operations. Node built-ins only.
- `dist/browser.js` and `dist/browser.css`: self-contained React workbench, with
  explicit application ports; no Core imports, Next aliases or global React.
- `dist/index.html` / `demo.js`: **synthetic**, offline browser demonstration.
- `sync-state.json`: frozen source commit and per-file input/output hashes.

The source engine never obtains credentials or launches an arbitrary CLI. The
embedding Host supplies a managed, repository-authorized READ query adapter.
Browser ports are temporary application interfaces, not SDK methods or permission
grants. The Host must enforce owner/repository scope, lifecycle and authentication.
A 401 is returned as-is; the package does not call Core-private session APIs.

```ts
import { createGhIssueSourceReader, FileIssueSourceStore, IssueSourceService }
  from '@clowder-ai/issue-workbench';

const reader = createGhIssueSourceReader(hostAuthorizedReadQuery);
const sources = new IssueSourceService(new FileIssueSourceStore(hostRetainedDataDirectory), reader);
// No network call occurs merely by importing or constructing these objects.
```

```ts
import { mountWorkbench } from '@clowder-ai/issue-workbench/browser';
import '@clowder-ai/issue-workbench/style.css';

const view = mountWorkbench(element, {
  repo: 'owner/repository', dataScope: 'stable-owner-scope',
  storage: browserStorage, request: authorizedSourceTransport,
  confirm: hostConfirmationDialog, openSettings: openHostAccountSettings,
  draftAssignees: ['selected participant'],
});
// One mount has one immutable scope. Unmount before changing repository/owner.
view.unmount();
```

The source transport currently accepts only the bound repository's catalog/detail/
refresh paths inherited from the existing workbench. It is an adapter seam, not a
new public Host HTTP contract. Discussion pages remain pinned to one archived
version. Full repository refresh can exceed a future SDK request deadline; the
SDK adapter must use an operation reference rather than widen that deadline.

## Current data and action boundaries

Source snapshots/archives persist in the explicitly supplied directory. The preview
stores work records through a synchronous storage port, with a key scoped by owner
and repository. The demo uses browser localStorage, **not** final Host persistence.
It does not automatically read/migrate the old Core origin or remove old data.
In the standalone READ workbench, tasks and label changes remain local drafts.
The separately authorized team module above performs explicit assignment and
comment writes. Neither surface automatically accepts a fix. Remote changes do
not overwrite local decisions.

## Development and validation

Use the repository's artifact toolchain: Node 24.18.0 and npm 11.16.0, pnpm 9.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/issue-workbench check:manifest
pnpm --filter @clowder-ai/issue-workbench lint
pnpm --filter @clowder-ai/issue-workbench test
pnpm --filter @clowder-ai/issue-workbench build
pnpm --filter @clowder-ai/issue-workbench test:artifact
pnpm --filter @clowder-ai/issue-workbench exec playwright install chromium
pnpm --filter @clowder-ai/issue-workbench test:browser
node scripts/pack-publish-artifact.mjs packages/issue-workbench /tmp/issue-workbench-pack
pnpm --filter @clowder-ai/issue-workbench preview
```

`preview` binds only 127.0.0.1:5196 by default (`PORT` overrides it). It uses
synthetic observations and never connects to GitHub or an existing Core service.
Browser acceptance extracts and serves the actual tgz in a temporary directory.
The artifact test installs that tgz outside this monorepo and exercises persistence
through public exports with no runtime dependency install. No production data is used.

## Adjustable workspace columns

The multi-source workspace has two draggable separators. Drag either separator
to resize the queue or investigation pane while keeping the reading pane usable.
Focus a separator and use Left/Right (20px, or Shift for 50px); Home/End select
its limits. Double-click or press Enter to restore both default widths.
Widths are remembered in this browser without expiry. Storage being unavailable
does not prevent adjustment during the current session.

Layout follows the workspace container, including when embedded in a narrower
Host: above 1100px all three panes are visible; at 721–1100px the queue stays next
to the selected reading/investigation view; at 720px or less the view buttons
switch between panes. Resizing preserves unsaved inputs and independent scrolling.

`src/layout/` owns this behavior in Plugins. `scripts/columns-adapter.mjs` adds the
small render/CSS integration when reproducing the frozen Core slice. The source
commit and input hashes remain unchanged; `sync-state.json` records the adapted
output hashes. This does not change Core or claim the SDK/Host cutover is complete.

The classification-first flow is another explicit plugin-side delta:
`scripts/triage-adapter.mjs` applies the reviewed replacements in `triage-adapter.json`
after the existing layout/team adapters. All 39 mapped files remain reproducible
from the unchanged Core cut; only the six affected output hashes change. A changed
source seam still requires reconciliation. No Host edit or sync-policy retirement
is needed for this UI adjustment.

## Fixed optimization-sync workflow

Until SDK cutover, the existing Core feature branch remains the source for mapped
business/UI files. This repository owns packaging, ports, build/test adapters and
sync tooling. `scripts/source-map.mjs` is the **explicit allowlist**, not a recursive
copy of Core. It excludes actual snapshots, credentials, settings fixtures, Host
routes/guards and unrelated files. Three Host-only API tests and the plugin-directory
shell test stay in Core; business assertions migrate with their source files.

This historical export procedure does not authorize changing Host. The current
no-Host-change instruction takes precedence; the frozen source cut stays unchanged.

For an optimization with separately authorized source changes:

1. Implement and test it on the current Core Issue feature branch. Commit the
   mapped files; freeze its full 40-character SHA. No working-tree export.
2. Fetch/reconcile public `origin/main` into the Plugins feature branch, including
   other contributors' changes, before taking the new export cut. Record the public
   base in the PR. Never reset, force-push or overwrite a community contribution.
3. Run the same two commands (replace placeholders with the actual source checkout
   and frozen SHA):

   ```sh
   pnpm --filter @clowder-ai/issue-workbench sync:core --check --source /absolute/core-checkout --ref SOURCE_SHA
   pnpm --filter @clowder-ai/issue-workbench sync:core --write --source /absolute/core-checkout --ref SOURCE_SHA
   ```

   `--check` is read-only and intentionally fails when an update is due. `--write`
   validates all mapped inputs/targets before writing. It refuses changed source
   seams, uncommitted mapped files, symlink targets, unowned existing files and
   public-side edits relative to the previous receipt. It writes the receipt last;
   identical reruns do not touch files. It does not push or publish.
4. Run `--check` again and the validation commands above. `sync:verify` checks the
   committed output hashes offline in public CI; it does not falsely claim access
   to an unpublished source commit. The contributor verifies source hashes in the
   source checkout. Record both SHAs, validation, artifact integrity and the change
   description in the same open PR; after merge, use the next feature branch/PR.
5. If an exported file was independently changed in Plugins, reconcile that delta
   back into the source or adjust the explicit adapter first. Update the receipt
   only after reviewing the old/new content; no `--force` overwrite switch exists.
   Interrupted writes fail the next hash check: use the Git diff/previous commit to
   recover the generated package files before retrying. No user data is involved.

This is a per-optimization workflow, not a background timer. An agent resuming the
work reads the source SHA, policy and destination receipt first. Every shipped
optimization must have a matching export PR/cut, or be explicitly listed as pending.

## SDK cutover: one deliberate change of source ownership

A version being published is necessary, but not sufficient. Switch only after:

- exact contract/SDK versions and a compatible public Host build are frozen;
- real Settings install → configure/authorize → enable → Workspace is verified;
- retained work storage, old-origin import, upgrade/reinstall and revoke are tested;
- real user-initiated cat task/result/acceptance remains in the delivery plan.

Then move the remaining adapters to the public SDK and set
`sync-policy.json.mode` to `plugin-native`. The canonical `plugin.yaml` already
permits package admission; it does not by itself complete that ownership change. The exporter will reject further Core exports. Issue business/UI
changes thereafter originate here; Core consumes exact packages and only changes
for generic Host behavior. Retire the old business copy after migration acceptance.
There is no permanent bidirectional file synchronizer.

### Find an issue to relate

In the multi-source entry, type part of a title, `#number`, or source name in
`关联问题`. Combine fragments with spaces, for example `公开 #88` or `重复 加载`.
Select the result (or use arrow keys and Enter), enter the relation/evidence and
save. Search covers all readable issues; only the first 30 matches are shown until
you narrow the query. Editing the query clears the previous choice. Saving creates
a local relation and never changes the source platforms.

### Notify a GitHub member to take a task

Dispatch defaults to `设置 GitHub 负责人`: after confirmation it writes the Issue's
Assignees using the repository's assignment permission. Open Issue rows and details
show `未认领` or `已认领` with every assignee's login. Invitations, analysis and local
drafts do not establish ownership. Legacy snapshots show `认领状态待更新` until a
source refresh fills the missing metadata. A verified read after dispatch updates
the page immediately; refresh sources to pick up reassignment or removal on GitHub.

In the existing member control, optionally choose `通知成员接手` and confirm the
public invitation. This posts a task comment mentioning the member without
changing GitHub assignees. `邀请已发布` does not mean the member accepted or claimed it.

The recipient installs/enables the candidate in a compatible Host, logs into their
own GitHub account, saves the allowed repositories and organization, and enables
`启动后接收我的分配` with their local inbox thread/cat. Login alone does not run a
listener. Startup and the 60-second schedule reconcile persistent Issue comments,
including offline backlog, and deduplicate already delivered work. Notifications
can be read or cleared without losing the task. Only unchanged protocol comments
from current organization members are accepted; ordinary mentions are not tasks.
Reports return to the Issue only when progress sharing is explicitly enabled.

For automatic classification dispatch, save `dispatchMode=invitation` and enable
`automaticAssignment`. Existing installations with an unset mode retain assignment
behavior. Invitation attempts never probe assignee write permission; actual comment
API failures remain visible for retry. Source changes, deleted/edited invitations,
closure or another assignee deactivate delivery without deleting history.

This candidate still needs the previously identified generic Host integration and
real installation acceptance. The packed two-installation journey uses isolated
fixtures; it does not prove real members were notified. See
[invitation evidence](../../docs/evidence/issue-workbench-github-invitations.md).

## Content-based origin and operating system

The classification overview filters by origin (internal, external, shared, unknown)
and affected OS (Windows, macOS, other; multiple selections in a result). CodeAgent
and CodeHub are internal clues; explicit public/community editions indicate external
scope. Shared scope needs explicit shared reproduction or a common-problem statement.
Conflicting or missing clues remain unknown; GitHub hosting alone proves no origin.
Normal comparison environments and unchecked template choices are excluded.

Rules use titles and matching saved analysis bodies, then refine from the authorized
body read when an issue opens. Each result exposes its evidence and whether the body
was read. Rules are conservative candidates, not a complete natural-language classifier.
Cat analysis instructions ask for the same dimensions in the reasoning. Manual labels,
Feature bindings and historical records are preserved; this writes no provider labels.

## Explicit issue categories

The workbench offers one fixed primary category selector instead of overlapping
module and local-tag text fields. Each option shows inclusion, exclusion and an
example. Saved choices drive local queue/overview/detail grouping after reload;
Feature bindings take precedence. Multiple candidate subjects and unsupported
legacy names remain undecided. Historical custom tags are retained read-only.
New cat tasks use the same category boundary table. Origin, operating system and
request kind are separate dimensions. Local edits do not change remote labels or
the authority of existing team analyses and assignment rules.
