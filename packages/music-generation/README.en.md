# Google Cloud music plugin candidate

[中文](README.md)

This directory currently contains a pending-connection component, not a complete installable plugin. The package is private and absent from the release workflow and plugin catalog.

The component records the current consent flow, selected Cloud project, expiry and cancellation. Later settings requests reuse the same flow. A callback from an older project selection cannot replace the current flow. Metadata stays in Host-provided installation storage; it contains no access token, refresh token or authorization code.

The callback helper must have its own durable lifetime and retain its challenge and result independently of a settings request. This component consumes only opaque completion references. Its `ready` state means that the helper has a result; it does not mean credentials were saved, billing was confirmed, the plugin was enabled or music was generated.

The real Google callback helper, existing-authorization reuse, settings actions and secret-target persistence, plugin manifest, Cloud generation and authorized Host file delivery still need integration. Current tests exercise the component without browser operations, real credential reads or generation requests. Existing authorization must be checked and reused before asking an owner to sign in again.
