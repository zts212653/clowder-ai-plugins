# @clowder-ai/plugin-sdk

Runtime helpers and typed Host interfaces for Clowder AI plugins.

Public SDK methods use the existing instance token and caller context; new manifests and SDK bindings contain no API permission lists. Host ownership, resource visibility, lifecycle checks and business approval still apply. Stopped contexts reject new calls and late results.

The current [Host ↔ plugin interface baseline](../../docs/plugin-development.md) documents identity, both call directions, cancellation and the management lifecycle. Interface changes must update that baseline and its drift checks with the implementation.

[Project setup and installation](../../docs/plugin-projects.md) distinguishes published SDK dependencies, workspace development and historical evidence. Use the exports of the actual SDK version installed by your plugin. Source availability is not an npm release.

Business mappings live in plugin storage. The Host client supplies installation identity and action context; config and secret getters read the latest effective values. Plugins explicitly refresh their own cached resources through configRefresh. Plugins own their business helper processes and release them in stop/dispose.

The module types include optional `host.memberSessions` for controlled member execution. Feature-detect the actual Host port; installing declarations alone does not enable it. `create` and `prepare` require a confirmed authenticated owner operation; the owner can still `revoke` without confirming a new grant. The Host freezes existing account/model/carrier references and approved personal-memory revisions and supplies only the declared native MCP contribution. `execute` retains the original execution ID and complete input on recovery; `getExecution` reads its durable receipt without waking a member. A new Host activation requires owner renewal. Credentials and copied login state do not belong in these DTOs or plugin storage. These capabilities do not add stdio or feature-context member execution.

Candidate.6 adds optional `describe` and `ensureThread` methods; check each before using it on an older Host. Owner-only `describe({catId})` reads nonsecret account choices, actual carrier support and approved memory references/revisions/byte counts. It creates no thread or grant and performs no model or login action; it makes no quota or live-authentication claim. Pass an available option's `selection` to `prepare`; its absence means use the existing native default path. `ensureThread` requires confirmed owner authority and a stable package business `creationKey`. It returns the same protected thread across HTTP request IDs and lost acknowledgements, without authorizing execution. Save that binding before resource preparation. The key is an idempotency coordinate, not an owner credential; changed frozen thread input conflicts. Use `prepare` separately after the owner has selected resources.

## Addressed response outcomes

For an addressed message, `messaging.send` may include `replyTo` and
`response: { deliveryId, status }`. Use the real delivery ID supplied by the Host;
status is `processing`, `completed`, `failed`, `canceled`, or `interrupted`.
The Host checks the authenticated instance, thread and original source before
linking the outcome to the existing delivery record. Text or attachments can
arrive while processing; they do not imply completion. Report a terminal outcome
when the backend actually finishes. Queue delivery acknowledgement remains a
separate transport fact. Reuse the message idempotency key on retries.
