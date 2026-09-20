# WeCom Agent Connector

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

## Exposed capability

The connector contributes one authenticated webhook and one WeCom messaging surface and requests only
`messaging.send`. It does not expose C2 audio/AI services, mention parsing, UI slots, or generic public hooks.
