# Dot cloud conversation plugin

[Chinese guide](README.md)

Dot connects a paired ChatGPT cloud conversation to Clowder AI. The installed instance receives addressed messages; the cloud conversation reads each original source before returning text or original PNG images to the same thread. It can also ask participating house cats a question and receive replies to those questions.

Maintainer: the Clowder AI plugin team. This is a local candidate requiring the matching Host with explicit addressable plugin support. It is not published in the official catalog. Component and archive checks do not prove a real ChatGPT account connection.

## Installation and connection

Choose the local plugin directory or the complete supplied archive in Plugin Manager. The archive carries its runtime dependencies; no separate SDK installation is required. The supplied complete archive is verified on macOS Apple Silicon; other platforms need a source build with matching native dependencies and have not been accepted. Open the connection operation, prepare the connection, enable the plugin, then follow its pairing instructions in the intended cloud conversation to subscribe to summons. Installation, setup and legacy import entry points are provided by the matching Host.

Pairing pins the selected callback URL. Reconnecting replaces the pairing attempt and invalidates older summons. Disconnect revokes the current credential. The optional preset external credential can remain empty: pairing generates it, and migration retains an existing credential without asking you to enter it again. Keep credentials out of public conversations and diagnostic logs.

The optional proxy supports a loopback HTTP CONNECT endpoint. Direct HTTPS callbacks validate public addresses and pin DNS resolution. The Host owns the installation identity, alias and icon.

## Use and recovery

Select Dot in a conversation and send a message. A delivery receipt confirms receipt of the summon; a model reply appears later as an ordinary plugin message. Every summon must be read separately before replying. An event from another thread or pairing does not grant reply authority. New originals enter ordinary Host message and media storage through attachment streams.

Connection status separates pairing from recent source-read, reply and image evidence. After enabling, start a roundtrip test, have the cloud conversation reply with the random nonce in the source, and run the connection test to confirm. A subscription or successful HTTP response does not prove a model reply.

Disable revokes the runtime and aborts network requests. Enable restores durable pairing and subscriptions only for threads with existing questions. External clients cannot continue calling a disabled plugin. Configuration, pairing, requests and original images survive disable and uninstall; historical messages are retained.

## Upgrade and legacy data

Migration preserves credentials, pairing, subscriptions, event IDs and reply IDs while explicitly rebinding the installation identity. It validates the installation owner and image hashes and sizes, returns resumable batch receipts, and never deletes the source files. Historical attempts remain evidence and do not become active grants.

The matching Host retains compatibility reads for historical image URLs. Import and legacy routing need joint Host acceptance. This package does not independently read another project directory or rewrite message history.

## Development

Install dependencies at the workspace root, build Contract and SDK, then run this package's typecheck, test and build scripts. The runtime entry is dist/plugin-entrypoint.js. The public migration export is ./migration; it accepts explicit records and original bytes rather than server filesystem paths.

Tests cover pairing, signed summons, read-before-reply authorization, image streams, retries, abort on disable, restart and legacy import. Account authentication, Settings and the full real roundtrip still require an isolated Host acceptance journey.
