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

The public 13-row wire already contains `messaging.send` and `host.messaging.deliver`, but that is not yet a
complete connector lifecycle. `ConnectorBindingAddress` can carry an already-issued opaque handle; an
external package currently has no public Host route to resolve or create that handle from
`(connectorId, externalChatId)`, nor can it recover the corresponding external-chat coordinate for outbound
delivery after restart. Core C1 therefore owns one business-blind activation prerequisite: Host-issued
connector-binding bootstrap/lookup and restart-safe outbound coordinates. The current external-runtime
supervisor also projects only four `CLOWDER_*` protocol metadata variables; the connector contribution has
no environment binding and the frozen wire has no config/secret read row. Core C1 must therefore project
only manifest-declared configuration and secrets into the verified package process (or provide an
equivalently typed Host-owned read path). These are parts of activating the existing connector contribution,
not a C2 mention parser, UI slot, or package-owned authority seam.

Restart-safe provider cursors are a third verified prerequisite. Although `plugin.state.get` and
`plugin.state.set` are reserved capability names, they are absent from the frozen wire registry and Core has
no handler, durable store, or external-runtime composition path for them. Packages must not substitute local
files, ambient Redis, messaging subscription cursors, seven-day settlement receipts, or inventory snapshots.
The stable design assumptions are Host-derived own-instance namespaces, manifest-declared keys, TTL=0,
compare-and-swap plus operation-id idempotency, and settlement-coupled checkpoint commits so crash replay
converges without skipping or duplicating a delivered message. Concrete SDK signatures remain blocked until
the public contract delta is approved.

The SDK does not yet expose a connector-facing session that combines handshake, Host requests, and
plugin-originating messaging requests. C1 adds the part that can be implemented against the frozen rows and
keeps provider runtime wiring blocked on the exact Host prerequisite above. Existing `connector`, `webhook`,
and `schedule` contribution declarations remain the static activation contract; packages must not invent an
ambient `.env` fallback, configured handle, or synthesized binding state to conceal the missing Host path.

Connector ingress always sends to a Host-authenticated `connector_binding` handle. Packages neither mint nor
resolve that handle and never infer wake authority from message text. In particular, `@` inside a plain
`thread_handle` message remains opaque, non-waking content; only Core may derive admission/wake behavior from
an authenticated connector binding. Contract/SDK fixtures lock both the connector-binding positive path and
the ordinary-text negative path.

## Test-first implementation sequence

1. Freeze this inventory and make `scripts/train-c1-inventory.test.mjs` RED because the eleven target
   packages and catalog entries do not exist.
2. Add SDK RED tests for a standalone connector session: ready handshake, outbound `messaging.send`, inbound
   `host.messaging.deliver`, grants change, ping, drain, and deterministic rejection after drain. Reuse the
   frozen wire rows. Synthetic binding handles are valid only for protocol-unit tests; they are not evidence
   that a provider runtime can bootstrap a real binding.
3. Hold provider runtime wiring at the Host boundary until Core supplies business-blind binding
   bootstrap/lookup, declared config/secret projection, and durable checkpoint paths. The checkpoint path is
   an unapproved public wire/schema delta, so restart/resume stays RED and no concrete SDK signature is
   frozen until approval; never hide any gap in package config or package-local persistence.
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
implementation-blocked-on-core-d-e`: unlike the Feishu and Weixin adapters, its tracking, cursor, lease,
binding, and event-publication implementation cannot close before the Core D/E authority surface exists.

Feishu retains verified webhook parsing, token refresh, cards, media transfer, and QR credential acquisition.
Weixin retains iLink polling, QR login, media transfer, and explicit cursor/context-token injection; its old
ambient voice-mode and Host API URL discovery has been replaced by manifest-declared inputs. GitHub Operations
freezes the seven schedule identities, polling periods, timeouts, and action methods while leaving tracking
registrations, cursors, leases, deduplication, repository bindings, and event publication behind one Host port.

This checkpoint intentionally does not add connector or GitHub packages to the catalog. Their declared stdio
entrypoints remain absent and therefore fail the generic packed-entrypoint assertion. Catalog closure, fresh
consumer activation, and publication stay RED until Core supplies the approved binding/config/checkpoint and
external schedule callback composition. The package directories and preservation tests may be reviewed now;
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
