---
feature_ids: [F170, F202]
doc_kind: plan
created: 2026-10-20
status: implementation
---

# Play Xiangqi with the cat in the current conversation

Owner continuation: `thread_muj7u295taln61l7#0001792481821510-000899-01469f6f` authorizes a playable, usable result and merge. This continues the existing F170 execution; it does not duplicate the original owner's Task.

Before: the package supplies analysis tools and a synthetic board adapter. After: install and enable the package, ask the chosen cat in the chosen conversation to open a game, follow its board link, confirm a move, and see that same cat's personally selected reply. Reopening a game preserves its journal.

## Existing interfaces and scope

Consume F202 C1's public module `create/start/stop`, stable `dataPath`, `messaging.get/send`, member/thread reads and authenticated `PluginActionContext`. The installed package declares native MCP actions. Opening a game derives the owner/thread/cat from that authenticated call and verifies a direct owner source; tool arguments cannot nominate another identity. The existing conversation is the selection UI, so no new Core UI slot, private message route, or interaction-action protocol is needed.

The original September plan assumed these executable interfaces were absent. Its unreleased contract/SDK drafts are superseded, not promoted. The board remains a plugin-owned loopback origin, launched by its lifecycle; no chess implementation or arbitrary plugin JavaScript is injected into the Host renderer. Rule evaluation and search run in a plugin child process, not the API process. Host credentials are never forwarded to that child or browser.

C1 grants ordinary conversation APIs at owner scope; it does not provide a separate per-game thread ACL. The package validates the authenticated caller and stores each game's selected conversation/cat. This is application binding enforcement, not a sandbox for untrusted Node modules. Installation discloses conversation-reading and messaging access. This follows the accepted Host/Package boundary in `clowder-ai/docs/features/F202-plugin-framework.md@43816128` rather than adding a second visibility system.

The native open call returns only an owner-session-protected Host launcher URL. It never exposes the browser bearer to the cat. The declared owner GET webhook verifies the installed instance, current owner and game binding, then serves a script-free page with an explicit link to that game's loopback board. C1 only permits relative same-origin redirects; the package does not widen that rule. The handoff page has no external resources and suppresses referrers. An unguessable fragment bearer is exchanged once for an origin-scoped sessionStorage credential; private state and all writes require that session. No cookie is used on the board, because cookies cross loopback ports and could leak to a sibling server. Host/Origin checks reject DNS rebinding and cross-origin writes. Confirmation is accepted only through this owner-delegated browser session, never from a bare `confirmed=true`. Native candidate reads/commits independently recheck the authenticated owner/thread/cat and the game revision. This replaces September's unimplemented Host-confirmation draft using the framework's existing owner HTTP authority.

Each running board has a random single-label `.localhost` hostname and accepts only that exact Host/Origin. Changing ports alone does not isolate cookies; the browser regression seeds both `localhost` and `127.0.0.1` Host cookies and verifies neither reaches the game. Reserved localhost resolution follows [RFC 6761 section 6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3); the actual Chromium journey verifies the supported browser path. Concurrent launches share a reserved creation promise, counted before listening. Only an immediate duplicate companion commit can return success; undo or any later revision invalidates it.

Architecture cell: plugin.
Map delta: none; public module and native-action consumers only, game authority stays in the installed plugin.
Why: reuse the new framework's real identity and lifecycle rather than grow a second Host session protocol.
Canonical source: `packages/plugin-sdk/src/{module-host,module-action-client,host-action-context}.ts`.
Consumer evidence: `rg -n 'createModuleActionClient|xiangqi\.(open|read|play)' packages/xiangqi`.
Claim guard: cross-owner/thread/cat calls, anonymous board reads, duplicate/stale moves and stop/restart are exercised through the real module and HTTP server.

## State and implementation

1. Merge current main into #66, preserve journal recovery, retire unexported drafts. Add an installed module entrypoint and native open/read/play tools; retain pure FEN tools.
2. A bounded child RPC owns board servers, retained games and analysis. The parent alone calls Host APIs. Persist per-game binding owner/thread/cat/generation beside the game; do not use an invocation ID as durable identity. Journal action IDs drive Host message idempotency and receipt reconciliation. A lost receipt repeats one message ID; it never repeats the chess move.
3. Only the bound cat's real native invocation can read candidates and submit. The worker never chooses automatically. Undo, a newer revision, revocation and changed binding invalidate old work. A terminal duplicate commit may return its original result; a different move or revision cannot reuse it.
4. Stop closes the child and sockets, rejects pending calls and marks explicit revocation without deleting games. Unexpected process loss preserves recoverable journal entries; restart rechecks the current Host thread and member before notification. New launches mint new browser sessions; old links cannot revive stopped authority.
5. Validate the packed package in an empty consumer and on the actual F202 C1 Host. Existing Host #1487/home intake is an external prerequisite, coordinated in its owning thread, not reimplemented here. Exercise two distinct bindings, real cat selection/commit, narrow browser play, refresh, recovery, disable/re-enable and retained files. Report fixture versus actual-runtime evidence separately.

Commands (from package scripts/current CI): `pnpm --filter @clowder-ai/xiangqi test`, `test:browser`, `lint`, `build`; affected SDK/contract conformance and fresh consumer checks; repository `pnpm gate:ci` before merge as required by its actual contract. Independent review covers the new final content; September's approval remains historical only. Merge only after applicable checks and review; npm publication/runtime installation remain separate actions.
