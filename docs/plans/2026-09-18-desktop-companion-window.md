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

## Companion bridge increment

The renderer bridge now has a schema-owned command/reply/event surface and a browser-safe SDK
subpath, `@clowder-ai/plugin-sdk/companion`. Commands cannot select a Host, owner, execution cat,
conversation or call handle. Replies project the actual selected deep actor and voice carrier,
but contain no session cookie or native credential. Provider errors map to a closed code set.
The Host must separately recheck its feature lease, current owner session and call lifetime;
schema validation is not authorization.

Voice preparation, household access changes, screen selection and conversation navigation require
real user activation in the trusted preload. Media capture additionally requires a ready Host call
and the current native selection. Installing a window or loading its page grants no capture. Screen
observations are bounded and untrusted; the executor and Host stamp their own current source/time.
Navigation reports `requested`, not a claim that a browser has visibly arrived.

The package-facing bridge carries no SDP. `audio.connect/close/microphone/speaker`
control a Host-owned peer inside the isolated preload. Only that peer negotiates
with the Host's private media pipe; its provider data channel is receive-only in
Host code, and no channel handle or arbitrary provider-event operation is exposed.
The package receives bounded typed audio/transcript events. Permission and call
revocation fence late replies before a new peer can become active.

`surface.integrity` covers the HTML entry file only. Hosts must verify the whole
installed package and serve a verified snapshot of referenced scripts/styles/assets;
the entry hash alone is insufficient. Catalog desktop packages have no runtime or
optional dependencies and cannot carry unresolved workspace dependency specifiers.
The SDK prerelease adds a required `windows` registrar to `FeatureContext`; consumers
that hand-implement that interface must update their test doubles.

Candidate verification after this increment: contract 376/376, SDK 304/304 and the expanded fresh
packed-consumer test 1/1. The downstream development Host has exercised a real Electron renderer
through preload and private pipes into its feature-bound callback; automatic voice preparation was
rejected. This is a bridge/kernel fixture journey, not the final companion UI, a real conversation,
or a publication receipt. The visible package and ordinary Host composition remain in progress.

## First visible package consumer

`@clowder-ai/companion` now builds a physical, declarative desktop-window package.
Its renderer uses the published-shape browser SDK, package-relative assets and the
Host-projected selected identity. It provides voice controls, typed input, an explicit
screen picker, persistent household-access preference commands and navigation to the
canonical conversation. It contains no Host URL, synthetic transport, recording branch,
credentials or second transcript store. Public Clowder imagery/theme provenance is
pinned in the package source lock; private pet metadata is not copied.

Package build, syntax lint and 23 behavior/asset tests pass. A real Chromium run of the
built page verifies the selected identity, no capture on load, explicit startup, mute,
uncertain-text retention and same-id retry, history navigation and household pause.
Media and Host replies in that browser run are fixtures; no microphone or screen was
captured. The installing Host's real packaged Electron journey and actual native
conversation remain separate acceptance requirements. The package is not published.

## Public release candidate verification

The public dependency chain is ready for independent review as one change: contract
`0.1.0-beta.16`, SDK `0.1.0-beta.11`, and companion `0.1.0-alpha.1`. The installing
Host integration is a separate repository change in the same product delivery;
publishing these packages alone does not complete that delivery.

- The catalog and module manifest exports are generated from the same object.
  The archive includes `plugin.yaml`, as required by the existing catalog contract.
- The artifact was packed with the release workflow's Node 24.18.0, npm 11.16.0
  and zlib 1.3.1-e00f703. Catalog validation extracts and validates each physical
  archive and checks exact integrity, manifest identity and entrypoint bytes.
- Existing GenOffice alpha.1 stays on its published beta.15 dependency and identical
  package bytes. Its test now checks that exact pin instead of tracking the next
  contract candidate under development.
- Publication still uses the existing guarded action, dependency order and `next`
  tag. The release tests include the new package and retain rejection of missing
  publication credentials, altered registry integrity checks and floating tools.

### Validation and failure repair

Native workspace build and typecheck passed. All nine package test suites were
executed. The initial recursive run stopped at the stale GenOffice assertion;
its four admission checks then passed after repair. The resumed contract run
found four stale publication-count/shell-block assertions; the affected two
files passed all 28 checks after repair. The remaining suites passed without
failures: SDK 304, companion 23, Feishu 66, Chrome companion 13, StackChan 44,
video analysis 13, and loopback runtime 91. Existing passing files were retained;
these results describe staged execution and repair, not one uninterrupted run.

Conformance passed 34 schema fixtures and 18 executed behavior cases. Generated
types are current. The repository-wide fresh npm consumer passed; the focused
window consumer additionally installs the physical companion, contract and SDK
tarballs together and validates their public imports without workspace links.

### Dogfood and limits

The final physical companion archive was installed by the development Host's
verified installer, opened with a Host-managed Electron component prepared from
its checked-in lock, and called the public SDK through the real isolated preload.
Opening caused zero conversation preparations. Canonical disable removed the
window presence. The exact candidate integrity is
`sha512-p91HkADQUGoRBz283xqNx41boo/HKxDVvsB4UKIiHX0Xqshpv5IfIWcepUKCehsqaybVV+u2kULrNgbWQccd7w==`.
Identity and native-provider replies in this integration check were fixtures;
no microphone or screen was captured. Real Chromium interaction with the built
page separately covered start, mute, uncertain text delivery and same-id retry,
history navigation, and household access changes. No matching `.pen` exists in
this repository; the package reuses the existing public companion visual assets.

Risk focus: new visible controls and media lifecycle (behavior), no independent
durable history (data), untrusted renderer input and explicit capture admission
(security), shared closed schemas and SDK exports (contract), and immutable
registry publication through the existing guarded action (release). Schema
validation cannot replace the consuming Host's owner/lease/gesture checks.
Actual household lookup, cross-provider reasoning and long-running conversations
remain acceptance work for the combined Host product, not claims of this package.
