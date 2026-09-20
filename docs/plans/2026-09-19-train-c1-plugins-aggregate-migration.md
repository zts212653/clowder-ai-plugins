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
   contained; disable/uninstall always disposes the active feature exactly once.
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
   C2's front-end contribution work (including the deferred audio/managed-service and physical-limb surfaces),
   not a third C1 PR for SDK/YAML/runtime/catalog debt left behind here.

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

The first clean checkpoint (`60bc85a`) contains five provider adapter slices plus video generation, WeChat
visible reader, Weixin MP, the frozen SDK rows, and a generic pack-time assertion that every declared runtime
entrypoint is an archive member. A second bounded slice adds Feishu and Weixin provider adapters plus the
GitHub Operations schedule/Host-port declaration, completing all eleven package directories without crossing
the Host authority boundary. GitHub Operations is explicitly `port-declared,
implementation-pending-in-plugins`: unlike the Feishu and Weixin adapters, its tracking, cursor, lease,
binding, and event-publication implementation has not yet been migrated from Core. That is remaining package
work, not a contract blocker.

Feishu retains verified webhook parsing, token refresh, cards, media transfer, and QR credential acquisition.
Weixin retains iLink polling, QR login, media transfer, and explicit cursor/context-token injection; its old
ambient voice-mode and Host API URL discovery has been replaced by manifest-declared inputs. GitHub Operations
freezes the seven schedule identities, polling periods, timeouts, and action methods while leaving tracking
registrations, cursors, leases, deduplication, repository bindings, and event publication behind one Host port.

This checkpoint intentionally does not add connector or GitHub packages to the catalog. Their provisional
runtime entrypoints remain absent and therefore fail the generic packed-entrypoint assertion. Catalog closure,
fresh-consumer activation, and publication stay RED until the carrier-neutral package modules and journeys are
complete and the parallel Core cutover can consume the reviewed artifacts. The package directories and
preservation tests may be reviewed now;
their provisional local pack coordinates are evidence of deterministic membership only, not release coordinates.
The guard is wired into `scripts/catalog-check.mjs` and covered by
`scripts/catalog-runtime-entrypoints.test.mjs`; it evaluates packed archive members rather than source paths,
so none of these draft manifests can enter the catalog with a dangling runtime declaration.

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
