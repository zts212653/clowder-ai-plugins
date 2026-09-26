# DingTalk Connector

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
`secret.read`, `thread.listMetadata`, `thread.write`.
