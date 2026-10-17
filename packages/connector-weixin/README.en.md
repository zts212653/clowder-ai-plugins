# WeChat Personal Connector

[Chinese](README.md) · English

`@clowder-ai/connector-weixin` packages iLink long polling, message normalization, QR login, media transfer,
typing, and reply delivery for a Clowder AI Host.

## Configuration

The Host projects the Bot Token and optional media behavior explicitly from the manifest. The Bot Token is
written only by the `weixin_qr_login` operation target. It remains hidden and required for runtime
readiness; QR setup is available while the plugin is disabled. Saving a token preserves the Host enable intent. Relative Host media URLs have no package-side base URL override
anymore: outbound media with a relative URL fails closed with a clear error instead of being silently sent.

## Security and authority

The Host owns installation, grants, credentials, connector bindings, wake policy, delivery, and durable
checkpoint state. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

The iLink polling cursor and context tokens use the existing Host-owned state surface. They must not be stored
in package-local files or ambient Redis. Rollback drains polling before the preserved Core adapter starts.

Inbound CDN locators share that manifest-declared private state surface but never enter the Host envelope,
logs, or transcript. Public messages carry only a `pmr_*` reference plus `sourceEventId`; the declared media
source serves bounded chunks and settlement deletes the locator.

The Host-loadable builtin runtime is implemented in this package and uses only the existing Host-owned
binding, configuration/secret, state, and messaging surfaces.

## Exposed capability

The package contributes one WeChat identity and message subscription and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`, `message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It also declares the `weixin_qr_login` operation (`qr-generate` / `qr-status` / `disconnect`) and a `weixin.test` connection check. QR login
obtains a Bot Token but leaves credential persistence and activation under Host control.

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
| `plugin.config.read` | Read this plugin’s saved configuration. |
| `plugin.state.get` | Read private business state held by the Host. |
| `plugin.state.set` | Save private business state, progress and deduplication records. |
| `media.read` | Read media references authorized for the current invocation. |
| `message.event.subscribe` | Receive authorized conversation messages and lifecycle events. |
| `messaging.send` | Send messages and replies to authorized targets. |
| `secret.read` | Read credentials explicitly granted to this plugin. |
| `thread.readContent` | Read authorized thread content within Host-checked scope. |
| `thread.listMetadata` | List metadata for accessible threads. |
| `thread.write` | Create or update authorized thread associations. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.

## Configuration and connection state

Setup and credential checks work while disabled. The Host saves successful credentials and preserves enable intent; only an enabled runtime opens the messaging connection. Saved credentials are not proof of a live connection. Use the current connection test to check runtime health.
The Bot Token is obtained through QR setup, not pasted into a separate permission form. Advanced voice settings remain hidden; no runtime environment override is read. Outbound media requires Host-authorized references, not arbitrary paths or URLs.
