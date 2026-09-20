# WeChat Personal Connector

`@clowder-ai/connector-weixin` packages iLink long polling, message normalization, QR login, media transfer,
typing, and reply delivery for a Clowder AI Host.

## Configuration

The Host projects the Bot Token and optional media behavior explicitly from the manifest. Relative Host media
URLs require an explicit `apiBaseUrl`; the package never discovers ports or reads ambient environment values.

## Security and authority

The Host owns installation, grants, credentials, connector bindings, wake policy, delivery, and durable
checkpoint state. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

The iLink polling cursor and context tokens require the pending Host checkpoint contract. They must not be
stored in package-local files or ambient Redis. Rollback drains polling before the preserved Core adapter starts.

## Exposed capability

The package contributes one WeChat identity and connector surface and requests only `messaging.send`. QR login
obtains a Bot Token but leaves credential persistence and activation under Host control.
