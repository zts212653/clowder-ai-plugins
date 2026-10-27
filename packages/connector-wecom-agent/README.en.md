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

The Host owns installation, caller context, configuration, secrets, webhook admission, connector bindings, wake
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

## Supported messaging

The connector supports authenticated WeCom webhooks, messages and media. It does not provide audio/AI
services or custom UI extensions.

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

The Host owns installation, caller context, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
