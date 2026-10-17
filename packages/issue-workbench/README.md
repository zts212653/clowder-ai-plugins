# Issue Workbench — pre-SDK package

A standalone extraction of the existing Clowder Issue workbench. It reads GitHub
observations, keeps versioned Markdown archives, and provides a browser workbench
for local annotations, solutions, evidence and task/label drafts.

**Status:** this alpha builds, packs and runs independently of the Core checkout.
It does **not** yet install/activate through Plugin Manager. `plugin.candidate.yaml`
is an independently versioned declaration candidate, with no executable contribution;
`integration.json` records the missing Host integration. It is deliberately absent
from the public catalog and automatic npm publishing. Do not rename the candidate
manifest or advertise an installable plugin until the fixed SDK adapter is verified.

## What is in the artifact

### Multi-source investigation (pre-SDK)

`mountCoordination(element, host)` adds an aggregate lightweight queue, independently
configured source preferences, manual issue relations and per-repository remediation
records. Source open/closed, local investigation and manually recorded verification
are separate; closing an upstream issue never verifies its downstream counterpart.
Label suggestions remain local drafts. There are no automatic remote writes, model
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
an issue, save a per-repo plan, link its counterpart, and record baseline + verification
evidence independently. Reload to recover the saved work. The supplied loopback Host
is for acceptance only; production installation must provide real owner authorization.
Its source registry is supplied by the Host, not an arbitrary URL/token form.

`ISSUE_COORDINATION_GITHUB=1` explicitly replaces the public fixture with the existing
isolated Clowder GitHub READ preview at port 3192 for `zts212653/clowder-ai`.
It does not connect an internal service. The `?legacy=1` trial link exposes the original
5192 workbench; old browser plans and label batches stay there, untouched. SDK cutover
must include an explicit data migration; it is not performed by this increment.

### Inspect initial classifications

Click **分类结果 · 12** in the GitHub preview header, or open
`http://localhost:5196/?legacy=1&classifications=1` to show the overview immediately.
The overview shows the 12 initial candidates, issue titles, four label dimensions
and supporting excerpts. Select an issue to open its candidate card. Click
**加入本地标记草稿**, edit the tags if needed, then **保存本仓记录** to retain them.
Existing tags are preserved; copying a candidate alone does not save or write to GitHub.

The versioned public seed lives in [data/initial-classification.v0.json](data/initial-classification.v0.json),
ships inside the tgz and is loaded by the example Host only for the matching public
repository. Other Host bindings may supply `classifications`; results must match
provider, instance, stable repository ID and a currently readable issue. Revoked
sources and their derived suggestions are hidden. A changed source timestamp flags
review; this is not continuous content-hash verification. The browser bundle does
not embed the seed. Hosts can pass `{ showClassifications: true }` as the optional
third argument to `mountCoordination` for this entry.

These 12 GPT-6-astra title/body suggestions are a deliberately selected sample,
not a full-corpus automated classifier, a measured accuracy result, or preaccepted
labels. Empty facets mean no evidence was extracted. The default synthetic trial
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
Tasks and label changes are drafts only. No dispatch, GitHub mutation or automatic
acceptance is implemented. Remote changes do not overwrite local decisions.

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

## Fixed optimization-sync workflow

Until SDK cutover, the existing Core feature branch remains the source for mapped
business/UI files. This repository owns packaging, ports, build/test adapters and
sync tooling. `scripts/source-map.mjs` is the **explicit allowlist**, not a recursive
copy of Core. It excludes actual snapshots, credentials, settings fixtures, Host
routes/guards and unrelated files. Three Host-only API tests and the plugin-directory
shell test stay in Core; business assertions migrate with their source files.

For each accepted optimization:

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

Then move the remaining adapters to the public SDK, replace the candidate manifest
with the tested executable `plugin.yaml`, and set `sync-policy.json.mode` to
`plugin-native`. The exporter will reject further Core exports. Issue business/UI
changes thereafter originate here; Core consumes exact packages and only changes
for generic Host behavior. Retire the old business copy after migration acceptance.
There is no permanent bidirectional file synchronizer.

### Find an issue to relate

In the multi-source entry, type part of a title, `#number`, or source name in
**关联问题**. Combine fragments with spaces, for example `公开 #88` or `重复 加载`.
Select the result (or use arrow keys and Enter), enter the relation/evidence and
save. Search covers all readable issues; only the first 30 matches are shown until
you narrow the query. Editing the query clears the previous choice. Saving creates
a local relation and never changes the source platforms.
