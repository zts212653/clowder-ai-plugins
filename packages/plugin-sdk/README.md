# @clowder-ai/plugin-sdk

Runtime helpers and typed Host interfaces for Clowder AI plugins.

The current [Host ↔ plugin interface baseline](../../docs/plugin-development.md) documents identity, both call directions, capabilities, cancellation and the management lifecycle. Interface changes must update that baseline and its drift checks with the implementation.

[Project setup and installation](../../docs/plugin-projects.md) distinguishes published SDK dependencies, workspace development and historical evidence. Use the exports of the actual SDK version installed by your plugin. Source availability is not an npm release.

Business mappings live in plugin storage. The Host client supplies installation identity and action context; config and secret getters read the latest effective values. Plugins explicitly refresh their own cached resources through configRefresh. Plugins own their business helper processes and release them in stop/dispose.
