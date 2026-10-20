# XiaoYi Connector

[Chinese](README.md) · English

`@clowder-ai/connector-xiaoyi` packages XiaoYi OpenClaw dual-WebSocket ingress and A2A egress for a Clowder
AI Host. It preserves provider authentication, heartbeat, bounded reconnect, session task ordering, duplicate
suppression, append accumulation, and explicit completion or failure frames.

## Configuration

- `accessKey`: XiaoYi OpenClaw access key.
- `secretKey`: XiaoYi OpenClaw secret key. The Host stores and projects it as a secret.
- `agentId`: XiaoYi agent identity used for authentication and session addressing.

The package does not read repository `.env` files or ambient Host configuration.

## Security and authority

The Host owns installation, grants, configuration, secrets, connector bindings, wake policy, and durable
checkpoint data. Inbound provider messages target only an authenticated Host-issued `connector_binding`;
message text, including `@`, cannot mint a binding or wake an Agent. Credentials are used only for the
provider WebSocket handshake and are never emitted in message payloads.

## Lifecycle and recovery

The adapter opens primary and backup WebSocket channels only after Host activation, stops both channels and
all timers during drain, and keeps provider retry bounded. WebSocket resume and deduplication watermarks must
be committed through a Host-owned, manifest-declared checkpoint namespace after accepted delivery.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding, declared configuration/secret, state, and messaging surfaces. The package intentionally provides no
local-file, ambient Redis, or environment fallback.

## Supported messaging

The connector supports XiaoYi messages. It does not provide audio capture, transcription, speech
generation, embeddings, LLM post-processing or custom UI extensions.

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

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
