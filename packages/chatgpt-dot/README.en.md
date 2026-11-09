# Dot cloud conversation plugin

[Chinese guide](README.md)

Dot connects a paired ChatGPT cloud conversation to Clowder AI. The installed instance receives addressed messages; the cloud conversation reads each original source before returning text or original PNG images to the same thread. It can also ask participating house cats a question and receive replies to those questions.

Maintainer: the Clowder AI plugin team. This is a local candidate requiring the matching Host with explicit addressable plugin support. It is not published in the official catalog. Component and archive checks do not prove a real ChatGPT account connection.

## Installation and connection

Choose the local plugin directory or the complete supplied archive in Plugin Manager. The archive carries its runtime dependencies; no separate SDK installation is required. The complete archive is verified on macOS Apple Silicon. Temporary ingress is not yet supplied for other platforms.

After enabling Dot, open “Dot connection”. The plugin steps explain the complete setup:

1. Choose a long-lived or temporary public endpoint and copy the returned Server URL. Repeating setup reuses a live endpoint and credential. Long-lived credentials have no automatic expiry; temporary ingress lasts up to 24 hours.
2. Open <https://chatgpt.com/plugins>, choose `+` → `Add custom MCP server`, paste the URL, and select `No authentication`. Remember the plugin name you chose.
3. Check the plugin details for Dot tools and the `dot.summoned` event. Refresh only if they are missing or their definitions have changed.
4. Click “生成订阅消息” (Generate subscription message) and copy its result. Open <https://chatgpt.com> and switch to **Work**. In the target conversation, type `@`, select the plugin you added, and send the message. Allow the subscription when prompted; a separate pairing-preparation action is not needed.
5. Return to “Dot connection” and wait for the subscription. The plugin starts verification automatically; no manual test is needed. Dot is ready only after it reads the source message and replies with the verification code. Then address `@dot` in a Clowder AI conversation.

The [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) uses a Work chat on ChatGPT web and requires rescanning after tool or event definitions change. See [Get started with Work](https://learn.chatgpt.com/docs/get-started-with-work) for the Work entry point.

Dot generates and retains its own instance-scoped access credential and authenticates requests through the existing generic Host webhook route. The Host owns installation identity, declared routing, permissions and runtime lifecycle, not Dot credential expiry. A long-lived full Server URL still contains a token and remains reusable across ordinary restart until explicit rotation or revocation. Temporary ingress retains its chosen expiry and closes on restart, disable or uninstall. Historical signed ingress remains migration compatibility with its original expiry checks. Explicit migration to a persistent credential produces a new URL that must complete discovery, subscription and roundtrip verification before replacing the protected formal connection. Reset rotates pairing only; disconnect revokes the credential and pairing. Keep full URLs and tokens out of public conversations and diagnostic logs.

The optional proxy supports a loopback HTTP CONNECT endpoint. Direct HTTPS callbacks validate public addresses and pin DNS resolution. The Host owns the installation identity, alias and icon.

## Use and recovery

Select Dot in a conversation and send a message. A delivery receipt confirms receipt of the summon. The reply position shows a waiting placeholder until visible text or attachments take over. A full text reply reports completion through the generic SDK response contract; acceptance alone never completes the response. Every summon must be read separately before replying. An event from another thread or pairing does not grant reply authority. New originals enter ordinary Host message and media storage through attachment streams.

After subscription, Dot automatically sends a verification event and waits for the cloud conversation to read the source and return its random nonce. Duplicate subscriptions and restart reuse the verification job and existing evidence. Failure exposes a reason and Retry automatic verification; credential updates retain the protected current connection and a cancel action. An interrupted test-thread creation with an unknown outcome stops automatic recovery and asks for explicit retry, avoiding repeated thread creation. A subscription or successful HTTP response does not prove a model reply.

Disable revokes the runtime and aborts network requests. Enable restores durable pairing and subscriptions only for threads with existing questions. External clients cannot continue calling a disabled plugin. Configuration, pairing, requests and original images survive disable and uninstall; historical messages are retained.

## Upgrade and legacy data

Migration preserves a still-valid access token, pairing, subscriptions, event IDs and reply IDs while explicitly rebinding the installation identity. It validates the installation owner and image hashes and sizes, returns resumable batch receipts, and never deletes the source files. The Host rechecks legacy authority before cutover; revoked or expired legacy credentials are never adopted or restored.

The matching Host retains compatibility reads for historical image URLs. Import and legacy routing need joint Host acceptance. This package does not independently read another project directory or rewrite message history.

## Development

Install dependencies at the workspace root, build Contract and SDK, then run this package's typecheck, test and build scripts. The runtime entry is dist/plugin-entrypoint.js. Legacy Host data migration is not a public manifest/action capability; before enable, the Host's isolated Dot compatibility adapter invokes the batch importer exported at `./migration` through its owner-operation fence. Batches accept explicit records and original bytes rather than server filesystem paths.

Tests cover pairing, signed summons, read-before-reply authorization, image streams, retries, abort on disable, restart and legacy import. Account authentication, Settings and the full real roundtrip still require an isolated Host acceptance journey.
