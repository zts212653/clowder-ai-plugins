---
title: Train C1 Plugins aggregate migration plan
feature_ids: [P-1, F202]
topics: [plugin-migration, im-connectors, business-plugins, catalog, release]
doc_kind: plan
created: 2026-09-19
---

# Train C1 Plugins aggregate migration plan

## Outcome

One Plugins PR turns every remaining in-scope Core IM connector and repository-local business plugin into
package-owned, cataloged artifacts. Core then consumes those exact reviewed artifacts, maps existing
configuration/bindings/data, proves no double-run, switches the default path, and deletes the old business
implementations in its separate deletion-dominant C1 PR.

The machine-readable frozen inventory is
[`migration/f202-train-c1-inventory.json`](../../migration/f202-train-c1-inventory.json). It is pinned to
Plugins `123112c`, Core `9ab0eaf287381efcb209781463f38cc5f23870ea`, and accepted Core issue #1478.

## C1 Terminal Acceptance Contract

This section is the durable finish line for the two-PR C1 cutover. It supersedes earlier wording in this
document that generalized the M0 standalone/stdio carrier into the product topology or treated the eleven
migration rows as the whole repository compatibility surface.

1. **The package is the distribution unit; the carrier is an implementation detail.** Each installable
   package declares its runtime strategy in its canonical manifest. `builtin`, `stdio`, and any future
   supported carrier all enter the same Host-owned lifecycle/action boundary; one package does not imply one
   dedicated process, and provider business behavior never moves into Core merely because the Host chooses a
   carrier.
2. **The Host consumes one carrier-neutral lifecycle/action boundary.** The package module exposes declared
   feature activation, contribution action handlers, and idempotent disposal. The Host supplies grants,
   config, secrets, bindings, ingress, logging, state, scheduling, and lifecycle authority through public
   SDK adapters. Failed activation publishes no partial contribution; action failure is attributed and
   contained; disable/uninstall always disposes the active feature exactly once. A `builtin` runtime with a
   root `entrypoint` has exactly one discovery convention: the imported ESM module's `default` export must
   satisfy `PluginModuleEntrypoint` and pass `requirePluginModuleEntrypoint`; named-export probing is forbidden.
3. **PR #54 closes repository-wide compatibility.** Its terminal inventory classifies every package directory,
   not only the eleven migration rows. Every Manager-installable artifact must have one canonical
   `plugin.yaml`, the stable `contractVersion: 0.1.0` line, an explicit SDK compatibility disposition, an
   honest runtime declaration whose packed entrypoint exists when declared, catalog truth, deterministic
   pack evidence, and a fresh-consumer installation/import journey. Legacy `manifest.json` forms are either
   mechanically identical/generated from the canonical YAML or explicitly non-Manager baselines; they are
   never an independent source of truth.
4. **Core PR #1487 converges and deletes atomically.** Core maps the exact reviewed package actions into the
   generic Host lifecycle, proves no-double-run, switches the default, and deletes each legacy execution path
   in the same cutover. Core must not retain or introduce a package-id/provider-specific runtime branch.
5. **The dependency order is evidence-bearing.** Plugins produces exact Linux-packed artifacts first. Core
   consumes those exact coordinates in the install/configure/enable/use/disable/uninstall/restart journeys.
   #54 merges and publishes before #1487 can receive final acceptance; #1487 then pins registry-resolvable
   version, shasum, and integrity rather than a mutable branch or dist-tag.
6. **Recovery is part of compatibility.** Disable and uninstall revoke actions and restore the preserved Host
   baseline; a failed start exposes zero partial actions; restart restores only Host-owned durable state and
   resumes without double-run. Package-local ambient authority, package-local durable checkpoints, and
   synthetic Host identities are forbidden substitutes.
7. **C1 has no cleanup follow-up PR.** The aggregate Plugins and Core PRs close C1 together. The next phase is
   C2's front-end contribution work (including the deferred audio/managed-service surfaces and the retained
   StackChan physical-hardware limb product), not a third C1 PR for SDK/YAML/runtime/catalog debt left behind
   here. `physical-limb` does not include the agent-side `limb`/`skill` contribution consumption used by
   `wechat-visible-reader` and `weixin-mp`; those consumers remain part of C1 compatibility closure.

This contract was cross-read against Core PR #1487 exact HEAD
`f20cc2dcd0c6612b89bf57d10f39a7fee802d0df`, section **8. C1 Terminal Acceptance Contract**. The two durable
contracts are aligned with no substantive disagreement.

The repository-wide package ledger in the inventory is executable acceptance data. A package may remain a
retained external baseline, library, fixture, or C2-deferred product, but that classification must be explicit;
absence from the catalog is not itself a classification.

## Frozen boundary

### Migrated in C1

- IM connectors: DingTalk, Feishu, Telegram, WeCom Agent, WeCom Bot, Weixin, and XiaoYi.
- Repository-local business plugins: GitHub operations, video generation, WeChat visible reader, and Weixin
  Official Account.
- Existing external artifacts are census baselines rather than duplicate implementations:
  `@clowder-ai/video-analysis`, `@clowder-ai/personal-chrome-companion`, and
  `@clowder-ai/feishu-meeting-intake`.

### Not migrated in C1

- ASR, TTS, audio capture, embedding, and LLM post-processing managed services belong to Train C2.
- C1 does not add public UI slots, generic public hooks, or another Host authority layer.
- Artifact verification, grants, secret/config authority, inventory, connector/thread bindings, delivery
  retry/dead-letter policy, and lifecycle supervision remain Host-owned.

This supersedes the pre-#1478 sentence in the Train B plan that placed managed services in undifferentiated
Train C. The accepted split is C1 connectors/business plugins and C2 public extension seams/managed services.

## Code-derived consumer census

The inventory records the source roots, config/secrets, binding and data truth, current consumers, dedicated
journeys, target package/catalog identity, runtime needs, and rollback for each item. The census is derived
from Core source at the pinned commit rather than from UI labels or an old planning list.

The shared execution shape is:

```text
package-owned provider/business implementation
  ↕ public plugin contract + SDK
Host-owned install/grants/config/secrets/lifecycle/bindings/delivery
  ↕
existing Core Agent, Console, messaging, schedule and webhook consumers
```

The wire contract remains the frozen 13-row protocol. C1 completes the already-authorized, carrier-neutral
module/lifecycle/action SDK boundary needed to execute the declared contributions; it does not add a
provider-specific wire, package-local Host authority, or a D/E checkpoint escape hatch. Host-issued
`ConnectorBindingAddress`, `messaging.send`, `host.messaging.deliver`, and Host-owned `FeatureContext`
adapters remain the authority coordinates.

Work proceeds in two implementation lanes. Plugins completes provider adapters, runtime entrypoints,
schedule operations, preservation journeys, and exact artifacts. Core maps its existing Host-owned
configuration, secrets, bindings, state, schedules, webhooks, and delivery authority into those frozen
surfaces, proves no double-run, switches defaults, and deletes provider-specific implementations. A missing
composition path is implementation work in the owning lane, not authority to invent a package-local fallback
or a new public contract.

Connector ingress always sends to a Host-authenticated `connector_binding` handle. Packages neither mint nor
resolve that handle and never infer wake authority from message text. In particular, `@` inside a plain
`thread_handle` message remains opaque, non-waking content; only Core may derive admission/wake behavior from
an authenticated connector binding. Contract/SDK fixtures lock both the connector-binding positive path and
the ordinary-text negative path.

## Test-first implementation sequence

1. Freeze this inventory and make `scripts/train-c1-inventory.test.mjs` RED because the eleven target
   packages and catalog entries do not exist.
2. Reuse the existing SDK tests for ready handshake, outbound `messaging.send`, inbound
   `host.messaging.deliver`, grants change, ping, drain, and deterministic rejection after drain. Synthetic
   binding handles remain protocol-unit fixtures rather than production binding evidence.
3. Complete every package runtime against the carrier-neutral manifest/SDK module surface. Core performs the
   generic Host-side mapping and cutover in parallel; neither lane invents a provider-specific Host branch.
4. Migrate provider-neutral connector fixtures first, then each provider adapter. Every package gets
   `plugin.yaml`, README, icon, locked production dependencies, provider protocol tests, restart/drain tests,
   and an isolated fake-provider journey.
5. Migrate the four business plugins with their actual runtime surfaces: MCP for video generation, limb/skill
   for Weixin MP, limb plus the macOS native helper for visible reader, and schedule/event contributions for
   GitHub operations. Package code imports no Core private path.
6. Add all eleven packages to the deterministic catalog. Extend exact-pack validation and fresh-consumer
   installation to every artifact; catalog metadata must equal packed manifest truth.
7. Run the aggregate quality gate and obtain independent cross-individual review on the exact HEAD. Leave
   the PR unmerged and unpublished until maintainer authority acts.

## Implementation checkpoint

> **Current as of 2026-09-26. If you are picking this up without having followed the thread, read this
> section first.** Earlier checkpoint texts (2026-09-20, 2026-09-23) are recoverable from git history. The
> Host ledger remains the truth source for per-slice specs, review verdicts and artifact sha256 (see "Where the
> truth lives").

### Where things stand

PR #54 is a **draft** served from the fork (`mindfn/clowder-ai-plugins`, branch
`feat/f202-train-c1-plugins-migration`). **Do not merge or publish it yet**: it leaves draft only when it and the
Host PR zts212653/clowder-ai#1487 can merge together (owner decision, 2026-09-23). The contract is at
`0.1.0-beta.24` and the SDK at `0.2.0-beta.7`; neither is published to npm, and neither needs to be for the dev
wave, because the Host installs owner-supplied self-contained artifacts (Host S10).

| Wave | Scope | State |
|---|---|---|
| a / b step | contract + SDK; the seven connectors moved to the A2 shape (`message-subscription`, `context.messaging.*`, `{ params, invocation }` envelope) | done, cross-individually reviewed |
| W1 | video-generation, video-analysis, weixin-mp, enterprise-workflow (new package), wechat-visible-reader | **5/5 done on both sides**; Host copies deleted |
| W2 | the seven connectors + ChatGPT Pro | **package side done for the seven connectors**; ChatGPT Pro not started; non-blocking follow-ups queued — see below |
| W3 / W4 | GitHub cluster / collective + GenOffice docx | not started (Host side) |

### Contract / SDK line

Each version's shape was frozen in the Host ledger before it was implemented here.

| Version | What it added |
|---|---|
| contract `0.1.0-beta.19` | configuration fields `hidden` / `requiredWhen` (W2-2a) |
| contract `0.1.0-beta.20` / SDK `0.2.0-beta.3` | media entitlements (`media_ref`, `media.read`, media sources), a minimal `rich_block`, typed lifecycle delivery, subscription `presentation: 'v1'` |
| contract `0.1.0-beta.21` / SDK `0.2.0-beta.4` | shared `ThreadId`; the four lifecycle events carry a required `threadId` |
| contract `0.1.0-beta.22` / SDK `0.2.0-beta.5` | shared `MessageId` (Host message id); `LifecycleStartedEvent.placeholderLine?` and `replyTo?`; subscription `presentation: 'v1' \| 'v2'` — the Host sends the two new fields only to v2 subscriptions, and only Feishu declares v2 |
| contract `0.1.0-beta.23` / SDK `0.2.0-beta.6` | merged main's #59 companion-bridge changes — `decisions.read {offset, limit}`, `f221.inspect {proposalId}`, `nativeActivity`, `CompanionDecisions`, `bridgeVersion` 1.2.0/1.3.0; SDK `companion-client` gains `readDecisions` / `inspectF221` and `layout` panel types from `CompanionCommand`. C1 shape unchanged |
| contract `0.1.0-beta.24` / SDK `0.2.0-beta.7` | W2-3 shapes — `ActionDef.render 'row'` with `confirm` (1..200), `OperationRows` v1 bounds; `runtime.dataDirectory` single-segment name with the `data.directory` capability (SDK `context.dataDirectory` throws PERMISSION when ungranted); cloud-conversation-host contribution (provider chatgpt) with `cloud.conversation.host` capability, appendMessage/list/ack shapes and `CloudBridgeFailureDiagnosticV1`; `MAX_GRANT_ITEMS` 21→23 |

### W2 on the package side

- **W2-1** (done): feishu + wecom-agent webhook actions aligned to the Host S6b forwarding contract, with a
  stable provider idempotency key on every accepted inbound path. Its Host-side wecom-agent end-to-end run met
  the cutover gate below.
- **W2-2** (done): user-visible parity for weixin / feishu / wecom-bot. QR login and credential validation are
  reachable again as operations (`weixin_qr_login`, `feishu_qr_login`, `wecom_validate`), and Host-projected or
  env-only settings are hidden. This closes the drift listed in the 2026-09-23 checkpoint.
- **Consumption wave** (done) — the seven connectors on contract beta.20 and later:
  - typed message elements; media send and receive through `media.read` and media sources, with bounded
    inbound downloads;
  - lifecycle receipts: placeholder, catching up, blocked recovery, settle;
  - cat display names in the old Host shape — `【显示名🐱】` before text sent with `sendReply`, the card header
    otherwise — and group @ via `envelope.replyTo` resolved to the recorded inbound sender;
  - the Feishu placeholder (`【显示名🐱→发送者】` plus a receipt line picked by the Host, contract beta.22);
  - lifecycle hardening: state written before platform side effects, with a pending-effect marker so a crash
    cannot drop a blocked recovery message; settled records kept as tombstones and swept after 24 hours;
    delivery to every binding of a thread with per-binding isolation; the Telegram placeholder correlation
    keyed by lifecycle and chat and persisted across restarts.
  - Non-blocking follow-ups from the last review are queued in the thread (the outbound failure predicate,
    Telegram consumed-marker cleanup, "message is not modified" edits, missing tests).
- **W2-3** (not started): ChatGPT Pro as an installable wrapper around the existing `personal-chrome-companion`
  closure, not a second copy of its code.
- **W2-4** (Host side): removal of the connector-specific framework and IM pages, plus a generic
  thread-to-external-conversation binding list.
- The Host-side slices that consume these packages — the outbound media materializer (W2-5b), vendoring
  contract beta.22 (W2-5c-p2) and the real-artifact gate against the packed connectors — wait for a Host
  developer.

### Cutover gate on this PR (met 2026-09-23)

PR #54 was not to merge or publish until **both** held:

1. the Host cutover branch is actually running in the Host, and
2. **one of the seven connector packages** carries an external-origin `messaging.send` end to end on the real
   Host and it is accepted.

Both were met on 2026-09-23 by W2-1: the full cutover branch ran in an isolated Host, installed the approved
wecom-agent artifact, and accepted real provider traffic. The gate was deliberately narrow — every W1 package
installing cleanly did not satisfy it, and neither did green CI.

### Known drift

- Nothing open from the 2026-09-23 list (see W2-2).
- Multi-binding: the plugin thread API lets a plugin bind a second external conversation to an existing thread
  (`threads.bind`), but today's connectors only use `ensureByKey`, so in practice a thread has one binding. The
  packages already deliver to every binding, so nothing changes when a Host flow starts binding a second
  conversation.

### Dev-wave artifacts

Built outside the repo under `/Users/lang/workspace/github-lab/f202-w1-tarballs/`. Two kinds, kept apart on
purpose, because the Host's local admission does not compare catalog integrity and installing the wrong one
fails silently:

| | location | bytes | publishable |
|---|---|---|---|
| canonical npm tarball | top level | equal to the catalog pin (pinned toolchain) | yes |
| self-contained dev artifact | `self-contained/` | never equal to any pin; platform-bound | never |

Self-contained artifacts come only from `scripts/pack-self-contained-artifact.mjs`, which runs
`scripts/verify-self-contained-artifact.mjs` before publishing: `package/` layout per the Host staging rule,
zero symlinks, production closure equal to the shrinkwrap, and the Host `runtime.entrypoint` really loaded from
a relocated copy. Filenames carry a content digest and existing files are never overwritten. **Hand artifacts
over by full sha256, never by path.** Superseded ones live in `f202-w1-tarballs.superseded/`, outside the
delivery tree.

The current connector batch is the third one, built from `b3118d4`; the batches built from `6d03b02` and
`c19fdfd` are superseded. The full sha256 of every artifact is in the Host ledger and in the hand-over messages;
they are not repeated here because they go stale.

### Guards that must stay green

- install consent surface: a package README must disclose every capability any of its features declares
- offline shrinkwrap closure gate: the packed lock must contain the full transitive production closure
- packed-member guard (`scripts/catalog-check.mjs`, `scripts/catalog-runtime-entrypoints.test.mjs`): every
  declared runtime entrypoint must be an archive member, evaluated against archive members rather than source
  paths
- fresh-consumer default-export guard: the entrypoint must expose the Host-loadable module shape

### Merge-time step — every version this PR claims is provisional

PR #54 changes two upstream-owned packages outside F202, both because its own install-consent gate requires a
README consent surface on every Manager-installable package: `packages/companion` (README, plus the round-3 fix
for a prototype-key leak in `src/errors.mjs` `explainError`) and `packages/genoffice-docx` (README only).
Publishing is automated: on a push to `main` that touches a public package, Contract CI's `publish` job
(`.github/actions/publish-prerelease`) publishes every package version the registry does not have yet, with tag
`next`, and fails if an already-published version packs to different bytes. A version is therefore taken as soon
as it lands on `main` (#58 put companion `0.1.0-alpha.4` on `main` at 08:31Z on 2026-09-23; CI published it at
08:38Z), and a published version never gets new bytes — which is why this PR bumps companion to
`0.1.0-alpha.9` and genoffice-docx to `0.1.0-alpha.2` — #59 took
`0.1.0-alpha.5` on 2026-09-25 (merged 09:56Z, published to npm from main) and #60–#62 then took
`0.1.0-alpha.6`–`0.1.0-alpha.8` (the 2026-09-26 sync of `origin/main` verified this against
`https://registry.npmjs.org/@clowder-ai%2fcompanion`), so this PR's companion content ships
as `0.1.0-alpha.9`.

Every version this PR claims is provisional: companion `0.1.0-alpha.9`, genoffice-docx `0.1.0-alpha.2`,
video-analysis `0.1.0-alpha.2`, plugin-contract `0.1.0-beta.24`, plugin-sdk `0.2.0-beta.7`, and the first version
of each package this PR adds. Right before merging, a version is free only if it is absent from
`https://registry.npmjs.org` **and** not claimed by `main`'s `package.json` or catalog; if either check fails,
re-bump to the next free version and re-pack with the fixed toolchain. Query `registry.npmjs.org` directly:
a scope-level npm registry configuration overrides `--registry`, and a local npm config may point at a mirror that
lags. On 2026-09-23
`registry.npmmirror.com` still ended at companion `0.1.0-alpha.3` after npmjs.org had published
`0.1.0-alpha.4`, and an earlier version of this paragraph repeated that mistake.

One npm-naming note, fixed here so nobody re-derives it later (Host request, frozen in the ledger
2026-09-25): the contract `0.1.0-beta.18` on npm is #59's companion release. The A1 line also had a beta.18
(Host `fdee6a4bb1` consumed it) with different bytes. This repo's beta.19–22 exist only as canonical tarballs —
they were never published to npm — so once #54 merges, npm goes from beta.18 straight to beta.24. The Host no
longer accepts beta.18, so nothing on the Host side is affected.

What CI covers: `scripts/registry-publish-compatibility.mjs` fails when a catalog pin or a public package's
current version is already published with different bytes (it caught genoffice `0.1.0-alpha.1`, which round 5
had re-pinned without a version bump). It cannot see a version that `main` has claimed but not yet published,
and `catalog:check` only compares the branch against its own pins — hence the manual check above.

### Where the truth lives

- Host ledger (slice-by-slice status, wave table): `clowder-ai`, fork branch `feat/f202-c1-core-cutover`,
  `docs/plans/2026-09-21-f202-c1-contract.md`; Host PR zts212653/clowder-ai#1487
- Per-slice review records: the Cat Cafe thread "F202 Train C1 — Plugins aggregate migration"
- zts212653/clowder-ai-plugins#57 (git guards) is independent and can be merged first; its `package.json`
  overlap with this PR is two purely additive hunks, which will be carried over here
- `origin` (`zts212653`) still has three stale branches pushed by mistake — `feat/f202-train-c1-plugins-migration`
  at `839eaf8`, `feat/f202-c1-contract-sdk-a-step`, `feat/f202-c1-p1p2-wire-dispatch-into-contract`. This PR's
  real head is on the fork; those can be deleted.

## Preservation matrix and acceptance

Every migrated entry must prove:

- configuration values and secrets keep the same user meaning, sensitivity, required/conditional rules, and
  setup operation;
- binding identity and durable cursors remain Host-owned and survive package restart/rollback;
- inbound and outbound journeys cannot run in both package and Core implementations simultaneously;
- provider retry, formatting, upload/media, deduplication, credential scrubbing, and platform-specific
  behavior remain covered by the listed dedicated journeys;
- disable/drain/restart/resume/rollback settle honestly without losing acknowledged messages;
- package install works in a blank consumer using only public exports and isolated fixtures.

Terminal evidence for the aggregate PR is `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm conformance`, `pnpm catalog:check`, `pnpm test:fresh-consumer`, plus exact version/SHA-1/SHA-512 and
archive-member evidence for all new packages under Node 24.18.0, npm 11.16.0, zlib 1.3.1-e00f703.

## Release and rollback

The Plugins PR is additive. Its merge does not activate, cut over, or delete a Core implementation. Release
publishes one reviewed generation of contract/SDK (only if changed), all eleven packages, and the catalog.
Core pins the exact coordinates and performs per-item migration under a global no-double-run gate.

Rollback is therefore two-stage and recoverable: Core first drains/disables package runtimes and restores
the preserved Core routes against unchanged Host-owned config/bindings/checkpoints; only then may a bad
catalog generation be superseded. Published npm bytes are never rewritten or manually unpublished.
