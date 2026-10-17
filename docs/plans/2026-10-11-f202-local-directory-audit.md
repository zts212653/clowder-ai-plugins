---
feature_ids: [F202]
topics: [plugins, local-directory, migration, acceptance, source-map]
doc_kind: acceptance-audit
created: 2026-10-11
architecture-cell: plugin
---

# F202 C1 — repository directory selection audit

## Current finish line and responsibility

Original aggregate Task1843 remains with Sol. Operator sources are Host thread
`thread_mu8dg6h7l2x4ohsk#0001791692969613-000094-97be6e64` and `#0001791692987237-000096-6f26606d`:
Host removes plugin business; the plugin repository owns independent packages; in an isolated worktree the
operator selects a plugin repository directory and installs it. The whole C1 contract is still the boundary.
This audit answers coordination100; it creates no Task215, writer transfer, new carrier or release permission.

Before: operator must infer a package from old tarballs and manually distinguish source/build/dependency readiness.
After required: Manager accepts the selected repository package directory, presents accurate source/grant/state,
and its real journey runs once with the old Host backend removed. That after is **not yet accepted**.

Observed package source is clean `87ba2b849adcf091b53caa93f1abc25170096038`; this commit's changes are
an audit/metadata/guard/README correction, not a new runtime generation. Independent package verdict042 still
applies only to87ba2b8. Contract beta.36, SDK beta.20 and Collective alpha.2 archive bytes from045 remain unchanged.
Frozen W3 is5dd199e, connectors2878c98; no W3 source, archive or dependency pin was modified.
The original pre-build audit observed Host HEAD2bb09b1c4bda871867ffbcd1c0972c5458fd0a6a has active package/shared/lock/vendor WIP. It is not
clean or a successful independent-build checkpoint. Host owner100 reports build stopped at Manager browser-service
capability projection. Source `PluginManagerContent.tsx` has Git and archive buttons; local-directory exists in
`plugin-manager-routes.ts:101` but no directory-select UI is present at this snapshot.

## Build continuation after review118

The six-file audit at `dde3848c7da6790ba797dca3f90a2499e708992b` was independently
approved by reviewer118. The table below remains its pre-build observation, not the
latest physical readiness. Current post-build observations are in
[f202-c1-build-readiness.json](../../migration/f202-c1-build-readiness.json).

In the same writer checkout, frozen-lockfile/offline/ignore-scripts installation and
14 package builds succeeded: seven connectors, enterprise-workflow, Personal Chrome,
video-analysis, video-generation, wechat-visible-reader, weixin-mp and Xiangqi. GenOffice
alpha.2 separately completed fresh locked-source renderer/semantic-worker build,
typecheck, package tests14/14, semantic-artifact tests6/6, prepack and actual pack71 members.
No package source, manifest, dependency pin, lockfile or W3 bytes changed in these builds.

17 of18 canonical YAML packages now have all declared executable entries and direct
dependencies physically present here. **Only6 also match their exact direct pins.**
The seven connectors still declare SDK beta.15; enterprise-workflow, Chrome, reader and
MP declare beta.12. Their frozen workspace lock resolves `link:../plugin-sdk`, now beta.20.
All11 builds therefore compile against that workspace SDK; they are not old-pin consumer
proof. Preserve the original beta.15 connector checkout for its accepted graph. GitHub
here remains cold and declares35/19 while workspace support source is36/20; use the frozen
5dd199e W3 checkout and its exact artifact for current W3 evidence. Final coordinated
consumer-pin synchronization and actual installed closure remain aggregate work. Do not
silently substitute registry copies or mutate the frozen W3 checkout to manufacture parity.

GenOffice canonical archive SHA256 is
`0e158faca54097f08388c9b32ba6105d766f3c4d300eab5caac85bdcdf8ba914` (19,200,079
expanded package bytes,71 members). Its empty isolated consumer passed actual root import,
manifest and surface/worker SRI, inspect, tracked-change, deterministic replay, reread,
comment and hostile rejection. That consumer contains846 regular files /21,445,116 bytes,
with seven exact dependency versions and registry SRI matching the writer lock. Important
limit: the canonical archive embeds no dependency lock. R1 mirror URL failed the strict
source check; R2 unpinned npm resolution selected fast-uri3.1.8 instead of locked3.1.3 and
failed. R3 explicitly pins the isolated consumer from the writer's beta.15 snapshot. This
proves the tested physical consumer, not that arbitrary installs preserve that closure.
The archive is not a raw-directory/UI/Host acceptance substitute. Evidence scripts,
logs, failed attempts and the successful consumer lock are bound in the machine report.

Host owner125 reports directory UI90/90, zero skips and web typecheck; beta36 Manager
kind separately has build plus141/141. These are stage facts from its owner, not an
independent rerun here or actual directory-install journey. Host remains2bb09b1c plus WIP.
The exact Host [diagnosis](</Users/lang/workspace/github-lab/f202-handoff/host-directory-preparation-2026-10-11/diagnosis.md>)
was read: accepted W3 closure already has4574 regular files, above4096; Feishu's literal
runtime distribution census exceeds32MiB before positive globs. Selecting distribution
members and removing development dependencies alone is not proof that original budgets
fit. A bounded, reviewed resource policy and exact Node closure remain Host implementation
work; no quota exemption, filename-based deletion or registry replacement is approved here.

Meeting still lacks canonical YAML and the owned-records/MCP/send redesign. Chrome's
current generic setup/OS authority journey, GenOffice's post-cleanup real Host worker path,
public specialization cleanup and all actual directory journeys remain open. Video-generation
builds existing source only; separate safety Task2134 is not absorbed. This continuation
closes build absence for the named outputs; it does not close C1, release or operator acceptance.

Reviewer132 found one P2 in the first continuation capture: contribution runtime
entrypoints were omitted, hiding GitHub's third missing `dist/mcp-entrypoint.js`.
The producer now collects those declarations and regenerates the report; it is
SHA-bound in the report alongside the original RED. An independent recursive
manifest oracle (not imported from the producer) covers all18 YAML packages.
The guard changed from9 pass/1 fail to10/10 pass; deliberate removal of the GitHub
MCP entry or GenOffice worker entry also fails. GitHub still has three missing
entries here, and the aggregate17/6/11/15 counts and all runtime/pin boundaries
are unchanged. This repairs evidence completeness, not either missing runtime.

## Reviewed pre-build directory snapshot

R = `/Users/lang/workspace/github-lab/clowder-ai-plugins-collective-sol/packages/`.
P = `/Users/lang/workspace/github-lab/clowder-ai-plugins-connector-parity-sol/packages/` at2878c98.
W = `/Users/lang/workspace/github-lab/clowder-ai-plugins-p2e-astra/packages/` at5dd199e.
These are source coordinates, **not immediate install-ready claims**. Each R path below exists and is inside the
plugin repository. Declared entrypoints and direct dependency presence were read without importing business code.
The alternative P/W paths have builds/direct dependencies, but their raw-directory admission fails as recorded below.

| Package directory/version | Build and dependency readiness | Host cleanup at observed source | Actual current directory UI journey |
|---|---|---|---|
| `R/collective-connector` 0.1.0-alpha.2 | R: entrypoints and direct beta.36/beta.20 dependencies present; runtime reviewed042. Raw R directory refused (32MiB). No package listener. | Named backend/old runtime roots have zero tracked files; Client/page retained C2. | 87ba empty consumer1/1 uses fixture binding. Real Host/browser/Manager/31-controls and raw-directory journey open. |
| `R/companion` 0.1.0-alpha.26 | R: declared renderer present; no runtime dependencies. Static copy preflight below limits; no fresh build/SRI or live journey claimed. | C2 desktop/UI baseline; no new backend deletion claim. | Current directory UI, current assets/lifecycle not accepted. |
| `R/connector-dingtalk` 0.1.0-alpha.5 | R: 2 entrypoints and 2 direct dependencies absent. P/connector-dingtalk built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-feishu` 0.1.0-alpha.5 | R: 2 entrypoints and 3 direct dependencies absent. P/connector-feishu built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-telegram` 0.1.0-alpha.5 | R: 2 entrypoints and 2 direct dependencies absent. P/connector-telegram built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-wecom-agent` 0.1.0-alpha.5 | R: 2 entrypoints and 2 direct dependencies absent. P/connector-wecom-agent built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-wecom-bot` 0.1.0-alpha.5 | R: 2 entrypoints and 2 direct dependencies absent. P/connector-wecom-bot built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-weixin` 0.1.0-alpha.5 | R: 2 entrypoints and 3 direct dependencies absent. P/connector-weixin built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/connector-xiaoyi` 0.1.0-alpha.5 | R: 2 entrypoints and 2 direct dependencies absent. P/connector-xiaoyi built; raw admission refused (32MiB). Restore exact beta.15 graph, build, and prepare runtime closure. | Named old provider roots have zero tracked files; generic Host bindings/media remain. | Historical21/21 across archive/extracted-directory/file-Git; raw P directory now refused. Not current repository-directory UI acceptance. |
| `R/enterprise-workflow` 0.1.0-alpha.2 | R: 2 declared entrypoints and 2 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Named W1 backend roots removed (enterprise by canonical ledger); final Host compile/consumer proof not inferred. | Not accepted on current Host; no directory-select UI receipt. |
| `R/genoffice-docx` 0.1.0-alpha.2 | R: dist/index.js, renderer/index.html, semantic-worker.js and beta.15 contract dependency absent. build:renderer (not build alone), source-lock/SRI/prepack checks required. | Old materializer directory absent; generic materializer and2 tracked editor lifecycle files retained. | Oct8 alpha.1 used an extracted published archive and real worker. Current alpha.2 renderer and post-cleanup Host journey unaccepted. |
| `R/github-operations` 0.1.0-alpha.16 | R:3 entrypoints/5 direct dependencies absent. W built with exact beta.35/beta.19 graph; raw W directory refused (32MiB). W3 frozen. | Named GitHub/community/provider/schedule roots have zero tracked files. | r6 archive lifecycle and source360/browser369 uploaded archive passes retain scope. Not raw repository-directory/current Host PASS. |
| `R/video-analysis` 0.1.0-alpha.3 | R: 2 declared entrypoints and 3 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Named W1 backend roots removed (enterprise by canonical ledger); final Host compile/consumer proof not inferred. | Not accepted on current Host; no directory-select UI receipt. |
| `R/video-generation` 0.1.0-alpha.1 | R: 2 declared entrypoints and 3 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Named W1 backend roots removed (enterprise by canonical ledger); final Host compile/consumer proof not inferred. | Not accepted on current Host; no directory-select UI receipt. Separate safety repair task2134 is not absorbed into C1. |
| `R/wechat-visible-reader` 0.1.0-alpha.3 | R: 2 declared entrypoints and 2 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Named W1 backend roots removed (enterprise by canonical ledger); final Host compile/consumer proof not inferred. | Not accepted on current Host; no directory-select UI receipt. |
| `R/weixin-mp` 0.1.0-alpha.3 | R: 2 declared entrypoints and 1 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Named W1 backend roots removed (enterprise by canonical ledger); final Host compile/consumer proof not inferred. | Not accepted on current Host; no directory-select UI receipt. |
| `R/xiangqi` 0.1.0-alpha.1 | R: 1 declared entrypoints and 2 direct dependencies absent. Install locked per-consumer dependencies then package build; resource/asset closure and isolated journey required. | Repository compatibility baseline; not one of the11 original migration rows. | Not accepted on current Host; no directory-select UI receipt. |
| `R/feishu-meeting-intake` 0.1.0-alpha.10 | R: no canonical YAML; missing dist and15 direct dependencies. Alpha.10 remains legacy broker/events.publish, not owned-records/MCP/send redesign. | Named old broker/intake/auth/artifact roots have zero tracked files; retained cards are C2. | Not a current Manager directory candidate. C1 redesign and installed MCP/notification journey remain package-side work. |
| `R/personal-chrome-companion` 0.1.0-alpha.3 | R: canonical YAML exists;2 entrypoints and exact SDK beta.12 absent. Build extension+module, prepare runtime-only closure; generic maintenance/OS authority pairing still open. | Named old Chrome backend and rejected native-setup service/card roots have zero tracked files. | Batch9 alpha.3 archive/setup-runner receipt is historical. Generic directory/setup/Test/real pairing not accepted; installation is not connected. |
| `R/stackchan` 0.1.0-alpha.1 | No C1 canonical YAML; physical-limb product remains deferred C2. | C2 exclusion, not a silently omitted C1 migration. | No C1 Manager install claim. |
| `R/plugin-contract` 0.1.0-beta.36 | Library builds/direct dependencies present; support packages, not Manager-installable plugins. Keep exact pins per consumer. | Public plugin-specific specialization cleanup still needs the original C1 audit. | Not a plugin directory for Manager selection. |
| `R/plugin-sdk` 0.2.0-beta.20 | Library builds/direct dependencies present; support packages, not Manager-installable plugins. Keep exact pins per consumer. | Public plugin-specific specialization cleanup still needs the original C1 audit. | Not a plugin directory for Manager selection. |
| `R/loopback-fixture-plugin` 0.0.0 | Private SDK fixture only; no canonical plugin YAML. | Test baseline, not a production migration. | Not an operator installation target. |

23 package directories are accounted for;18 contain canonical YAML. Meeting, StackChan, contract, SDK and the
loopback fixture are the5 explicit non-Manager cases. Personal Chrome was wrongly classified as a non-Manager
legacy baseline despite its YAML and catalog entry; inventory now registers the actual declared module candidate,
without asserting its current runtime, setup, publication or connection acceptance.

## Concrete raw-directory refusal

The actual Host source `manager/local-package-admission.ts` copies **every** directory member, resolving
node_modules symlinks. It budgets expanded bytes to32MiB and files to4096. It does not use package.json.files
or distinguish runtime dependencies from workspace/dev dependencies. Read-only traversal located the Collective
failure inside `node_modules/@clowder-ai/plugin-sdk/node_modules/typescript/ThirdPartyNoticeText.txt`; GitHub
includes development types and connector closures include full development/provider trees.

`raw-directory-admission.mts` invoked that actual production class against9 built directories, with isolated
mkdtemp packagesRoot. All9 returned `PACKAGE_TOO_LARGE` before grant or inventory callbacks; all temporary
copied data was removed. No runtime activated. This verifies the refusal path, not a successful installation.
Current archive green is possible because it uses a bounded runtime-only packaged closure; the directory gate
cannot be marked green by supplying that archive or a different extracted path.

Exact Host seam returned to its owner: `copyLocalDirectory` / `copyPackageMember` / `archiveLocalDirectory`
(local-package-admission.ts:171–226), before installation grants/digest publication. The operator-selected repository
package path needs a generic, bounded source-preparation/materialization step consuming declared built distribution
members plus locked runtime closure, or an existing equivalent surface proved against the real caller. Keep source
label/digest, repeated preview/confirmation fences, hostile member/symlink validation and an explicit bounded
resource policy; do not run arbitrary package build scripts in Host, silently relax quotas, special-case a
package id, or turn this into operator tarball labor. Current policy differences are recorded above.
Package build/dependency/asset work remains with the original package writer; generic directory UI/admission remains
with Astra's original Host chain. This is an exact seam for pairing, not an invented implementation signature.

## Evidence and limits

Machine ledger: [f202-c1-local-directory-audit.json](../../migration/f202-c1-local-directory-audit.json).
Full physical observations/probe/source census are under
`/Users/lang/workspace/github-lab/f202-handoff/aggregate-directory-audit-2026-10-11/`:
`source-directories.json`, `host-source-census.json`, `raw-directory-admission.mts/.json`.
The raw probe pins SHA256 of the exact Host source loaded; ignored dist is not used. Host state did not become
clean merely because the probe used source. Physical leftover directories with zero tracked files are ignored
residue, not proof that deleted business has returned. The5 surviving infrastructure/connectors files are separately
retained Host binding/media/mention primitives; the name alone neither certifies nor refutes the full boundary.

Historical receipts read: connector-consumption-2878c98/r3/local-directory-feishu.json (source /tmp extracted
self archive), alpha16-installed-c6918c24/r6/acceptance-summary.md, community-direct-review-93fee434/accepted-369.json,
c1-install-sources-2026-10-08/local-directory.json and report.md (alpha.1 extracted published bytes).
Only the named roots were censused; no exhaustive all-history/dependency-closure claim is made. Message search
returned503, so exact supplied source anchors, canonical C1 ledger, local source and existing receipts were read.

Inventory guard9/9 passes after correcting stale W3 progress/catalog gating and bringing Chrome's declared
capabilities into README coverage. Frozen11 migration rows,5 managed-service C2 exclusions, release/final catalog
requirements, private Collective admission=false and existing exact W3 pins remain intact. This audit does not
rerun or approve a new runtime. Public docx/physical-limb and connector-specific SDK/contract cleanup mentioned in
original C1 still needs exact consumer mapping; no silent all-public-interfaces-clean claim is made.

## Next action and exit

Return the raw repository-directory seam and this current three-column ledger to original Host owner. Host continues
capability/build, directory UI and bounded admission pairing; package writer handles its actual source/build/asset
and meeting/Chrome/GenOffice gaps under original1843, coordinating shared files before changes. Final acceptance
must select exact repository directories in the same isolated Host checkout, display local provenance, grant/configure,
enable/use/disable/uninstall/restart and show no old producer or duplicate execution. No new Task or operator reapproval
is required for this already-owned work. Current C1/install/release/operator acceptance remain open.
