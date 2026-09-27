---
title: Xiangqi plugin delivery plan
date: 2026-09-27
status: implementation
---

# Xiangqi plugin delivery plan

## User journey and ownership

Before: the operator starts a repository-local server, types a data directory and port, relays a move into a chosen conversation, then asks the companion to run a separate search command and submit its choice. After the missing Host binding is implemented: the Host installs and enables a verified package, binds a companion and conversation, opens a retained game, routes a confirmed move, and exposes candidates for that companion to inspect before it commits. The person still confirms each board move. Resignation policy and replay remain unimplemented; this migration makes no automatic resignation decision. The companion, never the search worker, chooses its own move.

The plugin owns Xiangqi rules, search, stored game events, and the board assets. The Host owns package/grant authority, selected identity and destination, durable location, surface admission, notification, and runtime state. A plugin has no direct private messaging HTTP access and cannot choose a Host identity through an environment variable.

## Confirmed executable boundary

The current Host can install a builtin package and run a verified stdio MCP contribution. That supports a pure position-analysis tool. The builtin supervisor currently rejects non-MCP contributions; its MCP environment comes only from configuration/secret bindings. There is no Host-issued game-session binding, durable data root, or general board surface/confirmed-move notification path for this package. A private local board harness can verify behavior, but it cannot count as a Host-installed end-to-end journey.

## Contract-to-execution matrix

| Actual contract or SDK method | Current Host handler | Executable fixture | Remaining seam |
| --- | --- | --- | --- |
| `validateManifest`; builtin `mcp` stdio contribution | `BuiltinPluginContributionSupervisor.start` verifies package/grant state and starts stdio | In-memory MCP client lists and calls legal-move/search tools; manifest validation test | None for pure position analysis; package still needs an approved published artifact for catalog installation |
| `FeatureContext.state.get/set` | SDK adapter interface exists, but no chess game mount is passed to builtin MCP | Synthetic Host selects separate retained roots; journal/revision tests | Restricted Host storage capability or authorized mount for a selected game, without passing arbitrary roots through config/env |
| `HandleService.issueThreadHandle`; `messaging.send`, `messaging.appendElements` | `runtime-composition.ts` composes `HostBrokerControlPlane` and `createMessagingBrokerHandlers` | Synthetic callback records only confirmed board moves into separate destinations | Host-issued selected companion/conversation session, authorization and durable idempotent move notification; current send path alone does not wake the companion |
| `ui` contribution and `FeatureContext.ui.register` | Builtin supervisor rejects feature references other than stdio MCP; no board surface handler | Browser test at 1120/480 px covers preselect, confirm, refresh, chosen reply, undo and restart | Generic restricted UI mount and Host-selected binding; no desktop companion or content-editor protocol reuse |
| Package lifecycle/grant revisions in builtin supervisor and broker | Runtime state and grant fences exist for executable contributions | Two synthetic Host bindings plus revoke and restart tests | Carry those fences through the eventual board/candidate/commit surface and verify revoke/restore in a real Host |

The matrix distinguishes defined SDK types from executable Host routes. The mock adapter is a package test, not a claim that the Host can complete the journey.

## Work units

1. Move the existing dependency-free rules, notation, search, game journal, and worker into this package. Replace role-specific actors with human/companion. Tests cover revision conflict, stale analysis, forced/terminal positions, and two synthetic Host bindings with separate roots.
2. Expose only side-effect-free position analysis through the existing executable MCP contribution. Package the board as verified assets and a Host-adapter library; the Host adapter owns notification and session binding. Browser tests preserve preselection/confirmation/undo/restart.
3. Build and pack the package; run contract validation, exact tarball checks, and a fresh empty consumer. Keep the machine catalog unchanged until a real published tarball can be pinned.
4. Open a plugin-repository PR with the code and evidence. A separate generic Host contract is required for full installation-to-board acceptance; keep the PR and product state honest until that exists.

## State and recovery

Game events are append-only; revision equals event count. The Host selects the root and session before constructing the plugin board. Analysis is reusable only when physical data root, game ID, revision, FEN, and search version match. Undo/restart increment revision and invalidate outstanding candidates. Closing, upgrading, rolling back, or disabling the package retains user-authored game data by default; deletion is a separate explicit user action. Importing an old game, if later offered, must select its source, verify replay, copy into a new target, and leave the original untouched.

## Verification

Use this repository's `pnpm --filter @clowder-ai/xiangqi test`, `build`, and `lint`; the repository's contract conformance and catalog checks as applicable; and a physical `npm pack` installed into an empty directory. The isolated board harness must demonstrate a confirmed human move, Host-owned notification callback, companion candidate read and selected commit, refreshed board, stop/restart, and preserved game bytes. That mock callback is not a production Host integration.
