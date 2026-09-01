---
title: Train B terminal plugin foundation implementation plan
feature_ids: [P-1, F202]
topics: [plugin-catalog, plugin-yaml, plugin-sdk, contribution-contract, video-analysis]
doc_kind: plan
created: 2026-09-01
---

# Train B terminal plugin foundation implementation plan

## Outcome

The Plugins aggregate PR publishes the plugin-side half of the terminal management plane:

```text
machine catalog list/search/get
  → packed artifact install candidate
  → static plugin.yaml validation
  → configure
  → enable
  → use video-analysis through MCP
  → restart
  → disable
  → uninstall
```

The Core production route remains unchanged. A later Core aggregate PR consumes exact artifacts and
implements the terminal Manager/Marketplace/Agent/Console projection. Train C migrates every remaining
business plugin, IM provider, and managed service in one Plugins PR, then cuts over and removes old Core
implementations in one Core PR.

## Human authority and non-goals

- A human chooses install/grants, supplies secrets/configuration, and chooses uninstall data disposition.
- Agent public tools are exactly `plugin_list`, `plugin_search`, `plugin_get`, `plugin_install`,
  `plugin_set_enabled`, and `plugin_uninstall`.
- No public `plugin_update`, `plugin_repair`, or `updateAvailable` field is introduced.
- Train B does not switch the Core `video-analysis` default route, migrate production data, or remove any
  Core implementation or IM UI.
- Catalog discovery never grants execution authority. A verified artifact manifest only requests
  capabilities; the Host inventory and grants remain local Host truth.

## Ownership map

| Truth | Owner | Consumer |
|---|---|---|
| Catalog entries, versions, artifact coordinates, manifest metadata projection | `clowder-ai-plugins/catalog` | Host catalog provider, Agent/Console projections |
| Static access protocol and product metadata (`plugin.yaml`) | Packed plugin artifact | Contract validator, Host installer, Agent/Console |
| Manifest/catalog schemas and generated types | `@clowder-ai/plugin-contract` | SDK, Host, packages, conformance |
| Author facade and runtime-neutral contribution semantics | `@clowder-ai/plugin-sdk` | Plugin authors and packages |
| Installed artifact, integrity, grants, config/auth, intent, live state | Local Host inventory | Manager, Console, Agent |
| Video provider protocol and execution | `@clowder-ai/video-analysis` | Host-launched MCP process |

## Package closure

1. `@clowder-ai/plugin-contract` adds a closed catalog schema plus typed static contribution definitions.
   Generated TypeScript remains derived from schemas. Semantic validators reject duplicate IDs,
   cross-feature references, catalog duplicates, mutable/ranged artifact coordinates, and authority-like
   catalog overrides.
2. `@clowder-ai/plugin-sdk` adds the author-side `definePlugin`/feature-context contract and typed
   registration receipts/disposers without adding private Host objects or expanding the frozen M0 wire.
3. `catalog/catalog.json` is deterministic and validation-tested. Query helpers have stable list/search/get
   ordering, search every localized description, and never merge catalog state with installed state.
4. `@clowder-ai/video-analysis` owns its Gemini/Zhipu protocol definitions and MCP runtime, ships
   `plugin.yaml` plus its declared SVG icon and a publisher-owned `npm-shrinkwrap.json`, imports no Core
   private path, and scrubs credentials from errors. Every locked package is registry-bounded with canonical
   SHA-512 integrity so Host activation never resolves a new transitive closure from registry-time truth.

## Test-first sequence

1. Add RED catalog/manifest fixtures and generated-type assertions.
2. Implement schemas, validators, deterministic list/search/get helpers, then regenerate contract types.
3. Add RED SDK author-facade tests for feature ownership, duplicate contribution keys, disposer
   idempotence, stale/revoked context rejection, and sibling isolation.
4. Implement the public facade without creating a Host authority substitute.
5. Add RED `video-analysis` protocol, credential-scrubbing, MCP tool, manifest, publisher-lock, and
   packed-artifact tests.
6. Implement the package by moving the provider-neutral execution behavior out of Core truth into the
   plugin package; do not import Core source.
7. Extend fresh-consumer and CI pack/publish coverage to exact contract/SDK/video artifacts and validate
   the catalog entry against the produced tarball integrity, manifest metadata, physical icon member, and
   registry-only shrinkwrap. Materialize the packed video runtime with script-free `npm ci --omit=dev`.

## Acceptance evidence

- Focused RED→GREEN tests for every contract, SDK, catalog, and video package change.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm conformance`, and
  `pnpm test:fresh-consumer` from this worktree.
- Pack evidence records filename, version, SHA-1, SHA-512 integrity, archive members, publisher lock, and
  fresh install. Reproducible pack evidence uses Node 24.18.0, npm 11.16.0, and zlib
  1.3.1-e00f703; other tuples are not accepted as release coordinates.
- A fresh consumer imports only public package exports and runs the video MCP against an isolated local
  HTTP fixture; no production credentials or Redis are used.
- Exact branch HEAD and artifact coordinates are handed to an independent cross-family reviewer before PR.

## Rollback

The Plugins PR is additive and does not cut production paths. Reverting its single merge removes the new
catalog/schema/SDK/video artifacts. Core remains pinned to the last published contract/SDK until a later
exact-artifact consumption PR passes its own acceptance gate.
