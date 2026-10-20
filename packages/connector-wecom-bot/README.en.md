# WeCom Bot Connector

[Chinese](README.md) · English

`@clowder-ai/connector-wecom-bot` packages WeCom intelligent-bot WebSocket ingress, proactive replies,
frame-bound streaming, template cards, and encrypted media transfer for a Clowder AI Host.

## Configuration

- `botId`: WeCom intelligent-bot identity.
- `botSecret`: secret used only to authenticate the provider WebSocket session.

Both fields are user-pasted in the plugin configuration (the package has no QR login). The
`wecom_validate` operation (`Test and connect` / `Disconnect`) tests the credentials against the provider
without starting a messaging stream. The Host saves successful credentials and preserves enable intent:
enabled instances reload their connection; disabled instances stay stopped. The package does not read repository `.env` files or
ambient Host configuration.

## Security and authority

The Host owns installation, grants, secrets, connector bindings, wake policy, delivery, and durable state.
Inbound provider messages target only an authenticated Host-issued `connector_binding`. Group `@bot` text
may be normalized as provider syntax, but package text never decides Host admission or wake authority.

## Lifecycle and recovery

Disable and rollback drain the WebSocket, timers, cached frames, and active streams before another runtime
starts. Resume state and deduplication watermarks must use a Host-owned, manifest-declared checkpoint after
accepted delivery; package-local files, ambient Redis, and inventory snapshots are not substitutes.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding, declared configuration/secret, state, and messaging surfaces.

Inbound encrypted-media locators remain in manifest-declared private plugin state. Public messages carry
only a `pmr_*` reference and `sourceEventId`; the declared media source decrypts into bounded chunks and
settlement removes the locator.

## Connection controls

Use `wecom_validate` (`Test and connect` / `Disconnect`) and the `wecom-bot.test` connection check
to manage the configured bot. The connector supports WeCom messages and media; it does not provide
audio services or custom UI extensions.

## Commands and configuration

The builtin entrypoint intercepts `/where`, `/new`, `/threads`, `/use`, `/thread`, `/commands`, `/cats`,
`/status`, `/history`, `/unbind`, `/allow-group`, `/deny-group`, `/focus`, and `/ask` before ordinary ingress.
Commands reply through the provider and keep their audit quiet. Only an explicit body in `/thread` or
`/ask` requests Agent invocation; successful delivery is acknowledged only after the Host accepts it.
`/use` traverses the owner-visible live thread inventory beyond the first 50 rows, deduplicates IDs and
rejects a non-progressing or exhausted traversal instead of selecting from an incomplete list.

Group whitelist, administrators and the group-command restriction keep their original configuration semantics.
Use normal configuration controls; no permission JSON, separate initialization or legacy import is required.
The initial group whitelist and command restriction are off and the administrator list is empty.
Group management commands still require an explicitly configured administrator; an empty list grants nobody administration.

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.

## Configuration and connection state

Setup and credential checks work while disabled. The Host saves successful credentials and preserves enable intent; only an enabled runtime opens the messaging connection. Saved credentials are not proof of a live connection. Use the current connection test to check runtime health.
There is no QR login. Validation prefers current form input and leaves existing saved credentials intact on failure. Disconnect clears the corresponding credentials through the Host.
