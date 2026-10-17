# Xiangqi

[Chinese](README.md) · English

Xiangqi rules, search, retained game journal, and board assets for a companion game. The package exposes two **read-only position tools** through a builtin stdio MCP contribution:

- `xiangqi_legal_moves(fen)` returns legal moves, check state, and outcome.
- `xiangqi_analyze_position(fen, timeMs?, maxDepth?)` returns bounded candidates, completed search depth, principal variations, and search version. It never submits a move.

The package also exports `createHostedBoard` and `createHostedGame` for a future Host-bound game session. **The current Host does not execute this board contribution or bind a selected companion and conversation to it.** Installing the MCP contribution alone does not enable the board journey. No companion, conversation, user ID, private API address, or data directory is configurable as an arbitrary plugin environment variable.

## Retained data and rollback

Game files contain an append-only event list. Each move, undo, and restart advances the revision. Analysis reuse requires the physical storage root, game ID, revision, FEN, search version, and a complete safety pass to match. A stale candidate is rejected, including after undo returns to the same board layout. Disabling, upgrading, or uninstalling the package must retain game files by default; deletion is a separate explicit action. The current package performs no automatic import. A later migration must identify its source, replay and verify it, copy to a new destination, and leave the source untouched. The original private games are not part of this package or its tests.

## Current installation state

The builtin Host can verify and run the manifest's pure MCP contribution. A complete installed game additionally needs a generic Host-issued session and restricted board surface, durable storage capability, authorized confirmed-move notification, companion candidate/commit calls, and revoke/restore fencing. Until those exist, the board library and browser harness are not a production installation path. Catalog entries identify exact candidate bytes; catalog inclusion does not mean those bytes have been published.

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.

This plugin requests no additional Host capabilities (`capabilities: []`).
