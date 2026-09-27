# Xiangqi

Xiangqi rules, search, retained game journal, and board assets for a companion game. Version `0.1.0-alpha.0` exposes two **read-only position tools** through a builtin stdio MCP contribution:

- `xiangqi_legal_moves(fen)` returns legal moves, check state, and outcome.
- `xiangqi_analyze_position(fen, timeMs?, maxDepth?)` returns bounded candidates, completed search depth, principal variations, and search version. It never submits a move.

The package also exports `createHostedBoard` and `createHostedGame` for a future Host-bound game session. **The current Host does not execute this board contribution or bind a selected companion and conversation to it.** Installing the MCP contribution alone does not enable the board journey. No companion, conversation, user ID, private API address, or data directory is configurable as an arbitrary plugin environment variable.

## Host boundary

The Host selects the companion, conversation, display names, retained storage mount, and game before constructing an adapter. It verifies package identity, grants, caller, and lifecycle state on every action. The browser receives only a scoped board view and a local confirmation token; it cannot choose a target or a data path. The package validates Xiangqi moves, journal revision, FEN, and analysis freshness before committing a move. Search workers only prepare candidates. A companion must read the current candidates, choose a legal move, and explicitly commit it through an authorized Host call.

`createHostedBoard({ host })` requires a Host adapter with `openSession()`, `authorizeHumanAction(session, action, projection)`, `notifyConfirmedMove(session, event)`, `deliveryStatus(session)`, and `retryPending(session)`. For a move, `projection` contains an opaque object reference, expected state token, and operation digest. `createHostedGame(host)` requires `openSession()`, `authorizeCandidateRead(session)`, and `authorizeCompanionMove(session)`. The current executable Host does **not** implement this adapter. The synthetic adapter in `test/hosted-journey.test.mjs` proves package behavior only.

The Host's notification implementation needs an idempotent, durable delivery ledger tied to a confirmed action ID and digest. A process may stop after the journal commit and before the callback settles; the plugin reconstructs pending actions from its journal on restart and retries the same ID. The Host must return its original receipt for an exact retry without starting a second execution. No browser or worker may perform private messaging directly. The package does not claim the Host ledger or execution seam is implemented.

The F170 interaction preparation branch records a Host-issued confirmation action reference in the same journal event as the human move. Missing Host receipts are replayed with the same action ID; undo and changed binding generations are excluded from the pending view. The Host must validate the confirmation at a trusted human surface and return a durable receipt. The standalone board harness's `confirmed=true` button is only a UI affordance; the Host adapter must independently return the issued action reference, or the move is rejected. The generic Host admission/queue and restricted page are still a draft, not an installed product path.

## Retained data and rollback

Game files contain an append-only event list. Each move, undo, and restart advances the revision. Analysis reuse requires the physical storage root, game ID, revision, FEN, search version, and a complete safety pass to match. A stale candidate is rejected, including after undo returns to the same board layout. Disabling, upgrading, or uninstalling the package must retain game files by default; deletion is a separate explicit action. The current package performs no automatic import. A later migration must identify its source, replay and verify it, copy to a new destination, and leave the source untouched. The original private games are not part of this package or its tests.

## Verify this package

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/xiangqi test
pnpm --filter @clowder-ai/xiangqi build
pnpm --filter @clowder-ai/xiangqi lint
pnpm --filter @clowder-ai/xiangqi test:browser
```

The browser test uses synthetic names and a mock Host at 1120 px and 480 px. It covers preselection, cancellation, confirmation, companion candidate selection and commit, refresh, undo, restart, and stale draft rejection. The independent tarball and empty-consumer check runs in repository CI. No game data is needed to run the MCP tools.

## Current installation state

The builtin Host can verify and run the manifest's pure MCP contribution. A complete installed game additionally needs a generic Host-issued session and restricted board surface, durable storage capability, authorized confirmed-move notification, companion candidate/commit calls, and revoke/restore fencing. Until those exist, the board library and browser harness are not a production installation path. The machine catalog pins published tarballs and remains unchanged until a package is published with approval.
