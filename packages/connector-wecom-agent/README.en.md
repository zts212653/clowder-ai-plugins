# WeCom Agent Connector

[Chinese](README.md) · English

`@clowder-ai/connector-wecom-agent` packages WeCom custom-application callback verification, AES-256-CBC
decryption, normalized text/media ingress, token refresh, message sending, media transfer, and byte-bounded
reply chunking for a Clowder AI Host.

## Configuration

- `corpId` and `agentId`: WeCom enterprise and application identifiers.
- `agentSecret`: secret used only to obtain short-lived provider access tokens.
- `callbackToken`: secret used to authenticate callback signatures.
- `encodingAesKey`: secret used to decrypt callback bodies and URL-verification challenges.

The package does not read repository `.env` files or ambient Host configuration.

## Security and authority

The Host owns installation, grants, configuration, secrets, webhook admission, connector bindings, wake
policy, delivery, and durable state. Callback bodies are accepted only after signature, decryption, and corp
identity verification. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

Provider access tokens are short-lived process caches. Host webhook routing must drain before rollback so
the package and preserved Core callback handler never consume the same event concurrently. The package does
not persist callback bodies or credentials.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding and declared configuration/secret surfaces. No package-local environment or persistence fallback is
provided.

Inbound provider media IDs remain in manifest-declared private plugin state. Public messages expose only a
`pmr_*` reference plus `sourceEventId`; the declared media source returns bounded chunks and settlement
deletes the private locator.

## Exposed capability

The connector contributes one authenticated webhook, one WeCom message subscription, and one media source,
and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`,
`message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It does not
expose C2 audio/AI services, mention parsing, UI slots, or generic public hooks.

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
| `thread.listMetadata` | List metadata for accessible threads. |
| `thread.readContent` | Read authorized thread content within Host-checked scope. |
| `thread.write` | Create or update authorized thread associations. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
