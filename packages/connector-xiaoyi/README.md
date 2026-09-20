# XiaoYi Connector

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

Standalone activation uses the existing authenticated binding, declared configuration/secret, state, and
messaging surfaces. The package intentionally provides no local-file, ambient Redis, or environment fallback.

## Exposed capability

The connector contributes XiaoYi messaging and requests only `messaging.send`. It does not expose audio
capture, ASR, TTS, embedding, LLM post-processing, mention parsing, public UI slots, or generic public hooks.
