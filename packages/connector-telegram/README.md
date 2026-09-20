# Telegram Connector

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
