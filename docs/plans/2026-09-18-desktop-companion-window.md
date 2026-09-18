---
title: Host-governed desktop companion windows
doc_kind: plan
created: 2026-09-18
topics: [desktop, companion, plugin-contract, windows, feature-authority]
---

# Host-governed desktop companion windows

## Outcome and scope

A companion package supplies its desktop presentation; the installing Host supplies execution,
identity, conversation access, media admission, and lifecycle. Opening it must not start a second
backend or ask a user to copy an API address or credentials.

The first consumer opens the independent-window domain described in the plugin design §3.7.
Use the current typed static contribution and feature-context APIs. The signed M0 Broker wire
does not gain a parallel window command family in this increment.

## Contract and ownership

`desktop-window` is a feature-owned static contribution with an immutable package-relative HTML
entry, SHA-256 integrity, bridge version, companion role, and bounded presentation options.
The owning feature must request `windows.create`; a request is never an effective Host grant.
Declarations cannot choose a Host, user, cat, conversation, executable, or Electron security settings.

`FeatureContext.windows.register()` uses the same opaque Host lease, registration identity,
revocation and disposal contract as other typed contributions. It does not instantiate Electron or
mint authority. A Host consumer must verify current package integrity and grant revisions before
opening the surface, and must revoke the old authority before cleanup on disable or upgrade.

The Host creates a sandboxed window through its managed desktop executor. This executor attaches
to the installing Host; it must not require a separate desktop application that starts its own
backend. Package JavaScript stays in the sandboxed renderer. The executor holds the narrow bridge,
checks the exact sender/frame and active instance, and owns media permissions. No session cookie
or native model credential is sent to package code.

Window creation does not imply microphone or screen capture. Capture remains a separate explicit
user action, bound to the current conversation and selection. Hidden, closed, crashed and expired
windows must produce truthful Host presence. A disappeared desktop body restores the existing
conversation entry; durable messages and user preferences survive plugin teardown.

## Delivery sequence

1. Schema, generated types and semantic ownership checks; reject injected authority and unsafe entries.
2. SDK registration under existing feature leases; verify exact packed contract/SDK in a fresh npm consumer.
3. Companion package surface and bridge consumer, plus Host window admission/execution/lifecycle.
4. Same-Host install/open/converse/reconnect journey, grant revocation and package corruption tests.
5. Exact release artifacts through protected publication; downstream Host pins those bytes after publication.

Steps 1–2 are implemented in the current branch. They do not prove a desktop window has opened,
that conversation/media operations are integrated, or that the package is published. Candidate
versions are contract `0.1.0-beta.16` and SDK `0.1.0-beta.11`; existing consumer pins remain unchanged.

## Validation

- `pnpm --filter @clowder-ai/plugin-contract generate:check`
- `pnpm --filter @clowder-ai/plugin-contract typecheck`
- `pnpm --filter @clowder-ai/plugin-contract test`
- `pnpm --filter @clowder-ai/plugin-sdk typecheck`
- `pnpm --filter @clowder-ai/plugin-sdk test`
- `node --test scripts/desktop-window-consumer.test.mjs`

The focused artifact test covers the new contract and SDK without requiring unrelated editor
downloads. The full repository fresh-consumer test and the real companion journey remain required
at their corresponding release/consumer boundaries. Local package tests are not publication receipts.

Current candidate checks: contract 373/373, SDK 301/301, typecheck and generated-type freshness pass.
The focused packed-consumer test passes from extracted npm artifacts with no workspace links.
The downstream Host executor and the visible companion package are still implementation work.
