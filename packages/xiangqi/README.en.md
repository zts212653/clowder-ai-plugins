# Play Xiangqi with your cat

[简体中文](README.md) · English

Play Chinese chess with the cat you choose in a conversation. Preview and confirm your move on the board; that same cat reads candidates, personally chooses a reply, and submits it to the same board.

## Start a game

1. Install this package from a local directory or archive in the Plugin Manager, then enable it. The Host must include F202 C1 module and native-action support.
2. Ask the chosen cat in the chosen conversation to open a game. Its `xiangqi_open_game` tool returns a board link.
3. Open the link, select a piece and destination, inspect the preview, then confirm. Selecting or previewing never commits a move.
4. Wait for that cat's own reply. The board updates automatically. You can continue, withdraw a pending move, or undo a round.

Asking the same cat in the same conversation again resumes an unfinished game. Supply its game ID to reopen a specific retained game. Another cat or conversation gets a separate board and no authority over yours. The cat's launcher link requires your authenticated Host browser session. Keep the private board address after redirection to yourself; the cat never receives it. Complete that initial launch within ten minutes; a successfully opened page can refresh. After expiry or plugin restart, ask the original cat to reopen it.

The board runs on the Host machine; its loopback link does not work from remote browsers or other devices. The human currently plays red first. This version has no matchmaking, automatic play, automatic resignation, or multi-game replay UI.

## Recovery and retained data

A confirmed move is committed to its durable journal before notification. If notification fails, the board says the move is saved and provides retry. The same notification creates one message; recovery never repeats a chess move. Stale candidates or revisions require a fresh read.

Normal shutdown/restart retains games and rechecks the original conversation, cat and authority before recovering undelivered notifications. Explicit disable closes boards and revokes old sessions and pending work. After re-enabling, ask to continue in the original conversation. Uninstall retains authored game records by default. The package does not import private historical games automatically and needs no private message URL or user-directory configuration.

## Analyze a position

`xiangqi_legal_moves(fen)` returns legal moves, check and terminal state. `xiangqi_analyze_position(fen, timeMs?, maxDepth?)` returns budgeted candidates, depth and principal variations. Neither tool opens a game or plays automatically.

`xiangqi_read_game` and `xiangqi_play_move` accept game/revision/move inputs, never caller identity. Host-authenticated context supplies the caller. Search runs in the plugin's own process. The browser receives only a game-scoped credential, never Host tokens. Journals remain in the installation's data directory; notifications return only to the bound conversation.

## Maintenance and validation

Source version `0.1.0-alpha.2` consumes public SDK `0.2.0-beta.21` / Contract `0.1.0-beta.37`. Source presence does not establish publication or catalog availability. See the PR for exact artifacts, tests and Host acceptance.

Workspace commands: `pnpm --filter @clowder-ai/xiangqi test`, `test:browser`, `lint`, and `build`. Only explicit enablement starts the game process; discovery and installation do not start a game.
