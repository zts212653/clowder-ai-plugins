# Host configuration-variant integration

This guide describes the Host consumption of `configurationVariants` in contract 0.2.0. The contract implementation is part of [plugins PR #101](https://github.com/zts212653/clowder-ai-plugins/pull/101); Host integration is reviewed in [Host PR #1660](https://github.com/zts212653/clowder-ai/pull/1660). These links describe integration work, not a claim that candidate packages have been published.

See the [contract design](proposals/2026-10-21-plugin-config-variants-design.md), [Feishu manifest](../packages/connector-feishu/plugin.yaml), [video-generation manifest](../packages/video-generation/plugin.yaml), and [acceptance procedure](../review-notes/2026-10-21-experience-acceptance-prep.md).

## Shared contract API

Import the browser-safe `@clowder-ai/plugin-contract/variant` entrypoint instead of duplicating its rules in the Host:

- `coerceStoredValues` converts supported boolean/number storage strings to typed values. Invalid input remains invalid; secrets are not trimmed.
- `resolveConfigurationVariant` returns `selected`, `unselected`, or `invalid`. A declared default applies only when the stored discriminator is absent.
- `computeEffectiveConfiguration` projects common fields and active branch fields, applying field defaults. Inactive values remain stored but are excluded from this projection.
- `evaluateFieldRequiredness` evaluates `requiredWhen` when present; otherwise it uses `required`. Branch membership determines applicability, not requiredness.
- `buildVariantValidationSchema` produces JSON Schema for the effective configuration. Register standard URI formats (for example, `ajv-formats` with Ajv) before compiling it. Operation controls have no scalar value; their target-based configured state remains Host-owned.

Validate manifests before using these functions. The manifest validator rejects malformed branches, undeclared field references, duplicate options, and overlapping or incomplete branch coverage. Missing `configurationVariants` preserves the existing plugin path; malformed declarations must not silently select that path.

## Consumption paths

| Consumer | Required behavior |
|---|---|
| Settings form | Combine stored safe values with current drafts, including explicit deletion. Recompute visible fields immediately when the selector changes. |
| Save and readiness | Validate the effective configuration, including common fields and active required fields. Save the selector and active edits together. |
| Runtime configuration | Deliver only common and active fields through module getters, external runtime projection and declared MCP environment bindings. |
| Configuration refresh | Recompute the authoritative MCP description and subsequent launch environment after a saved mode change, preserving instance identity, lifecycle currentness and explicit disable controls. |

An untouched stored secret can satisfy an existence check without exposing its plaintext. Its placeholder is neither a comparison value nor a replacement secret. An explicit delete must remove that existence evidence and re-evaluate requiredness.

For manifests declaring variants, a missing selector without a default or an invalid selector prevents readiness/runtime startup. Settings and management operations must remain available to repair the configuration. Operation target resolution, caller/resource ownership and lifecycle checks retain their existing responsibilities. Configuration refresh does not create or preserve a per-plugin Host API or native MCP method allowlist; actual methods are resolved through the exported handler table.

Feishu's WebSocket branch excludes Verification Token. Its existing webhook handler skips delivery in WebSocket mode; this feature does not introduce a separate contribution-condition engine. Video-generation selects API Key or Access Key + Secret Key according to `authType`.

## Dependency and compatibility integration

The manifest's exact `contractVersion` declares the required protocol. It is distinct from the SDK and contract versions in `package.json`. A Host must explicitly support the declared protocol at installation and persisted-inventory restoration; an SDK upgrade alone must not rewrite plugin protocol requirements.

For candidate integration, use the contract archive from the same reviewed source revision and verify its digest. Install the Host lockfile normally and verify the package actually resolved by both API and Web, rather than assuming an installation exit code proves the expected bytes were loaded. Rebuild and restart the acceptance Host after dependency changes.

Local-directory installation can use built, installed source dependencies without public npm publication. Registry/catalog installation is a separate release path and requires published artifacts plus an activated catalog entry. Use an isolated acceptance environment and the linked procedure to verify configuration behavior before enabling external connections.
