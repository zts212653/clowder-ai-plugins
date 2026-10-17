# Telegram Connector

[Chinese](README.md) · English

`@clowder-ai/connector-telegram` packages Telegram Bot long-poll ingress and Bot API egress for a Clowder AI
Host. It accepts private human messages, preserves Telegram message and file IDs, renders safe Telegram HTML,
splits messages without cutting surrogate pairs or HTML entities, and drains polling before shutdown.

## Authority boundary

The Host owns the bot token, connector/thread bindings, admission and wake routing, durable polling cursor,
delivery retry/dead-letter state, grants, and lifecycle. The package never derives wake authority from `@`
text and never writes an undeclared local cursor. Provider updates are sent only through a Host-issued opaque
`connector_binding` address.

## Configuration

`botToken` is a required secret issued by BotFather. The Host must project only this manifest-declared value;
the package does not read repository `.env` files or log the token.

## Safety and recovery

Only private, non-bot messages enter the connector. Long polling has bounded conflict backoff and closes the
Bot API session on drain. A Host-owned cursor is committed only after accepted delivery so restart and
rollback do not double-run the package and preserved Core poller.

The Host-loadable builtin runtime is implemented in this package and uses only the existing Host
config/secret, connector-binding, messaging, and state surfaces. Adapter exports remain testable with
isolated fixtures.

Inbound Telegram file IDs remain in manifest-declared private plugin state. Public messages contain only a
`pmr_*` reference and `sourceEventId`; the declared media source serves bounded chunks and settlement deletes
the private locator.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `media.read`, `plugin.state.get`,
`plugin.state.set`, `message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`,
`thread.write`.

## Commands and configuration

The builtin entrypoint intercepts `/where`, `/new`, `/threads`, `/use`, `/thread`, `/commands`, `/cats`,
`/status`, `/history`, `/unbind`, `/allow-group`, `/deny-group`, `/focus`, and `/ask` before ordinary ingress.
Commands reply through the provider and keep their audit quiet. Only an explicit body in `/thread` or
`/ask` requests Agent invocation; successful delivery is acknowledged only after the Host accepts it.
`/use` traverses the owner-visible live thread inventory beyond the first 50 rows, deduplicates IDs and
rejects a non-progressing or exhausted traversal instead of selecting from an incomplete list.

This adapter supports direct conversations only. Configure the original account/login fields and receive messages;
there is no group-permission page, permission initialization or legacy-import step. Group management commands
do not grant a direct-message sender administrator authority. Existing stored data is not deleted.

## Install permissions

These capabilities come from the single `plugin.yaml`. The Host grants and checks their scope; this document does not grant authority.

| Capability | Purpose |
| --- | --- |
| `media.read` | Read media references authorized for the current invocation. |
| `plugin.state.get` | Read private business state held by the Host. |
| `plugin.state.set` | Save private business state, progress and deduplication records. |
| `message.event.subscribe` | Receive authorized conversation messages and lifecycle events. |
| `messaging.send` | Send messages and replies to authorized targets. |
| `secret.read` | Read credentials explicitly granted to this plugin. |
| `thread.listMetadata` | List metadata for accessible threads. |
| `thread.readContent` | Read authorized thread content within Host-checked scope. |
| `thread.write` | Create or update authorized thread associations. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
