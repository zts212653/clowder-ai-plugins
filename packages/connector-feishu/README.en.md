# Feishu / Lark Connector

[Chinese](README.md) · English

`@clowder-ai/connector-feishu` packages authenticated Feishu/Lark webhook and long-connection message
parsing, interactive cards, media transfer, token refresh, and QR credential setup for a Clowder AI Host.

## Configuration

The Host projects only the declared App ID, App Secret, connection mode, optional verification token, and
optional group mention aliases. The package does not read repository `.env` files or ambient Host state.

## Security and authority

The Host owns installation, grants, secrets, webhook admission, connector bindings, wake policy, delivery,
and durable state. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

Tenant tokens and downloaded media are transient runtime data. Rollback drains the package connection before
the preserved Core adapter starts, while Host-owned bindings and configuration remain unchanged.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding and declared configuration/secret surfaces. No package-local persistence fallback is provided.

Inbound provider media locators remain in manifest-declared private plugin state. Public messages expose
only a `pmr_*` reference plus `sourceEventId`; the declared media source serves bounded chunks and removes
the locator when the Host settles the import.

## Exposed capability

The connector contributes one Feishu identity, message subscription, media source, and verified webhook,
and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`,
`message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. QR setup
obtains credentials but does not transfer Host configuration authority.

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
App ID and App Secret remain required. QR setup writes those fields and connection mode, not the separate Webhook verification token. The optional group mention alias mapping is hidden from ordinary Settings.
