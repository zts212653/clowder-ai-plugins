# DingTalk Connector

[Chinese](README.md) · English

`@clowder-ai/connector-dingtalk` packages DingTalk Stream ingress and OpenAPI/AI Card egress for a Clowder AI
Host. It parses direct and group messages, preserves provider message IDs and media download codes, sends
bounded text/markdown/media replies, and shuts down the Stream client during Host drain.

## Authority boundary

The Host owns installation, grants, configuration and secrets, connector-to-thread bindings, admission,
wake routing, retry/dead-letter policy, and lifecycle supervision. The package never parses `@` text to
invent wake authority and never mints a connector-binding handle. It requires the Host to supply a verified
opaque `connector_binding` handle for inbound delivery and the corresponding external DingTalk coordinate
for outbound delivery and restart recovery.

## Configuration

- `appKey` is the DingTalk enterprise application App Key.
- `appSecret` is a secret and must be projected only from the manifest-declared Host configuration.

The package does not read a repository `.env` file and does not persist credentials. DingTalk access tokens
remain runtime-ephemeral. Group conversation identifiers may be checkpointed only through a Host-owned
store injected into the adapter.

Inbound provider media locators are retained only in the package's manifest-declared private state. The
public message carries a `pmr_*` reference and `sourceEventId`; the Host reads bounded chunks through the
declared media source, then settlement removes the private locator.

## Safety and recovery

Provider HTTP errors fail closed. Media upload and download responses are bounded by the provider contract;
error text must not include credentials. Disabling or draining the plugin closes the Stream connection before
the preserved Core adapter can be restored, preventing double consumption.

The Host-loadable builtin runtime is implemented in this package and consumes only the existing Host-owned
config/secret, binding, state, and messaging surfaces. Adapter exports are usable for isolated provider
conformance tests without claiming that synthetic handles constitute production activation.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `plugin.config.read`,
`plugin.state.get`, `plugin.state.set`, `media.read`, `message.event.subscribe`, `messaging.send`,
`secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`.

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
| `thread.listMetadata` | List metadata for accessible threads. |
| `thread.readContent` | Read authorized thread content within Host-checked scope. |
| `thread.write` | Create or update authorized thread associations. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
