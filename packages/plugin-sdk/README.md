# @clowder-ai/plugin-sdk

Runtime helpers and typed Host interfaces for Clowder AI plugins.

Public SDK methods use the existing instance token and caller context; new manifests and SDK bindings contain no API permission lists. Host ownership, resource visibility, lifecycle checks and business approval still apply. Stopped contexts reject new calls and late results.

The current [Host ↔ plugin interface baseline](../../docs/plugin-development.md) documents identity, both call directions, cancellation and the management lifecycle. Interface changes must update that baseline and its drift checks with the implementation.

[Project setup and installation](../../docs/plugin-projects.md) distinguishes published SDK dependencies, workspace development and historical evidence. Use the exports of the actual SDK version installed by your plugin. Source availability is not an npm release.

Business mappings live in plugin storage. The Host client supplies installation identity and action context; config and secret getters read the latest effective values. Plugins explicitly refresh their own cached resources through configRefresh. Plugins own their business helper processes and release them in stop/dispose.

The candidate.5 module types add optional `host.memberSessions` for controlled member execution. Feature-detect the actual Host port; installing these declarations alone does not enable it. `create`, `prepare`, and `revoke` require an authenticated owner operation. The Host creates the thread, freezes existing account/model/carrier references and approved personal-memory revisions, and supplies only the declared native MCP contribution. `execute` uses the original execution ID and complete input on recovery; `getExecution` reads its durable receipt without waking a member. A new Host activation requires owner renewal before further action. Credentials and copied login state do not belong in these DTOs or plugin storage. This candidate does not add stdio or feature-context member execution.
