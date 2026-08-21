---
feature_ids: [F247]
topics: [personal-chrome, chrome-extension, native-messaging, companion, public-plugin]
doc_kind: plan
created: 2026-08-21
architecture_cell: plugin
map_delta: none
architecture_why: public companion extraction preserves Cat Café as the Host lifecycle and user-state authority
---

# F247 Personal Chrome public companion implementation plan

**Feature:** F247 — Personal Chrome public-plugin extraction; canonical product
truth remains `cat-cafe/docs/features/F247-cloud-cat-family.md`.
**Goal:** Produce one independently reviewable, packable public-repository
candidate containing the F247 companion machine contract, MV3 extension source,
and POSIX Native Messaging helper source without moving Host authority or
publishing an artifact.
**Acceptance Criteria:**

1. The public package exports one versioned F247 companion protocol and rejects
   malformed append/binding/receipt messages before side effects.
2. Its packed artifact contains a buildable MV3 extension and a runnable POSIX
   Native Messaging helper closure; a fresh npm consumer can inspect and run
   the contained entrypoints without source-tree dependencies.
3. Conformance proves the extension has only the narrow ChatGPT conversation,
   `tabs`, and Native Messaging surface, with no focus/navigation/Cookie/private
   API escape hatch.
4. No public package change installs a manifest/launcher, creates or projects a
   pairing secret, owns lifecycle/user state, creates an Extension Hub protocol,
   or treats the companion as an F292 stdio plugin.
5. CI verifies the candidate but includes no `npm publish` or Chrome Web Store
   action. Windows stays explicitly unsupported.

**Architecture cell:** `plugin`
**Map delta:** none
**Map delta why:** This is an extraction into the existing public-plugin
boundary, not a new Host ownership cell.
**Architecture:** Add a standalone `@clowder-ai/personal-chrome-companion`
package. It owns the v1 wire grammar and distributable extension/helper source;
Cat Café remains the caller, installer, admission authority, pairing-secret
owner, lifecycle supervisor, and user-state owner. The package is deliberately
not a PluginManifest/stdio runtime and does not introduce a generic extension
broker.
**Tech Stack:** TypeScript, Node ESM, Chrome MV3, Native Messaging framed JSON,
Node test runner, pnpm pack, npm fresh-consumer install.
**前端验证:** Yes — the static MV3 manifest/source contract is tested. Browser
Store installation and signed-distribution verification are deferred.

---

## Authority, baseline, and scope fence

**Authority:** F247 Personal Chrome developer gate and zero-focus binding
documents establish v1 messages, least privilege, real-DOM receipt semantics,
and the signed-distribution gap. F292 supplies only package/release/fresh-
consumer conventions; its stdio runtime is not reused as the companion shape.

**Baseline:** `clowder-ai-plugins/origin/main@a0b3554` already provides the
safe pack helper and fresh-consumer precedent. Cat Café's current developer
artifact is a behavior oracle, not an installation implementation to migrate in
this slice.

**In scope:** public machine grammar, static extension sources, Node helper
closure, package metadata/build, packed-consumer evidence, and a non-publishing
CI validation path.

**Out of scope:** catalog/SRI/admission; manifest or launcher install/uninstall;
pairing-secret issuance; binding/status Settings; Host route/lifecycle state;
Chrome Web Store upload/signing; npm publication; Windows; any Remote MCP
writeback.

## Boundary and terminal shape

```text
Cat Café Host (retained)                 Public companion package
------------------------                 ------------------------
catalog/SRI/admission                    F247 v1 parser/types
install/uninstall + pairing secret  -->  MV3 extension source/build
lifecycle/user-state policy              Native Messaging helper closure
Settings + route/status                  pack/fresh-consumer/conformance
```

The package names only F247-specific messages: `append_message`,
`append_progress`, `append_result`, `bind_conversation`, `binding_result`, and
`query_binding`/`binding_status`. It does not expose a generic extension hub,
Host API, catalog model, or F292 `stdio` declaration.

The native helper consumes a Host-supplied pairing record and injected
Host-owned paths; it never generates a secret, chooses an install location, or
implements product lifecycle policy. Its persisted delivery mechanics remain
bounded by the supplied Host configuration.

## Stateful object census

| Object | Lifecycle owner | Public package role | State deliberately retained in Cat Café |
| --- | --- | --- | --- |
| pairing record / secret | Cat Café Host | strict read-only input grammar | creation, rotation, redaction, removal |
| Native Messaging manifest / launcher | Cat Café Host | source artifact only | platform install, allowed-origin policy, repair/uninstall |
| conversation authorization | Cat Café Host | typed bind/query messages | durable authorization, UI and recovery policy |
| delivery ledger | Cat Café Host | bounded helper implementation under injected paths | retention, lifecycle and user-visible status |
| extension service-worker view | Chrome | stateless projection | no `chrome.storage` binding copy |

## Invariants and adversarial matrix

- **INV-1:** Every v1 message is closed, versioned, bounded, and correlation
  fields are exact; malformed input cannot reach dispatch.
- **INV-2:** An append reports `host_observed` only with a real host message ID;
  extension progress/receipt is not a host receipt.
- **INV-3:** The extension may query/send only an exact `chatgpt.com/c/<id>`
  tab. It may not create, reload, activate, select, move, highlight, navigate,
  focus, inspect cookies, attach a debugger, or call a private ChatGPT API.
- **INV-4:** The package contains no installer, platform registry mutation,
  secret generator, catalog/SRI logic, or npm/Web Store publishing command.
- **INV-5:** POSIX is the only supported helper target. A Windows input or
  packaging claim fails closed and is documented as unsupported.

Adversarial tests cover malformed/oversized frames, foreign/mismatched request
and idempotency IDs, invalid bindings, duplicate terminal receipts, forbidden
extension APIs/permissions, missing packed files, and a fresh consumer with no
repository-relative imports.

## TDD implementation plan

### Task 1: Make the package boundary fail

**Files:**

- Create: `packages/personal-chrome-companion/test/protocol.test.ts`
- Create: `packages/personal-chrome-companion/test/extension-contract.test.mjs`
- Create: `packages/personal-chrome-companion/test/packed-artifact.test.mjs`

1. Write tests for every v1 parse arm, byte bounds, correlation constraints,
   and failure result.
2. Add static extension tests for exact permissions/host scope and forbidden
   Chrome API strings.
3. Add a packed-artifact test that expects a package manifest, MV3 assets, and
   helper CLI to exist in a raw unpack.
4. Run the focused package tests and preserve the expected RED because the
   package does not exist.

### Task 2: Add the F247-specific machine contract

**Files:**

- Create: `packages/personal-chrome-companion/src/protocol.ts`
- Create: `packages/personal-chrome-companion/src/index.ts`
- Create: `packages/personal-chrome-companion/package.json`
- Create: `packages/personal-chrome-companion/tsconfig*.json`

1. Implement only the closed v1 messages and bounded parser/types used by the
   existing F247 bridge.
2. Export the protocol through the package root; do not alter
   `@clowder-ai/plugin-contract` or add a PluginManifest.
3. Run the Task 1 protocol tests to GREEN, then typecheck/build the package.

### Task 3: Extract static extension and helper source closure

**Files:**

- Create: `packages/personal-chrome-companion/extension/manifest.json`
- Create: `packages/personal-chrome-companion/extension/{service-worker.js,content-script.js,chatgpt-page-adapter.mjs}`
- Create: `packages/personal-chrome-companion/native-host/*.mjs`
- Create: `packages/personal-chrome-companion/test/native-host.test.mjs`

1. Port the proven F247 v1 source with no Cat Café installer or Settings code.
2. Keep Host paths/configuration injectable; reject missing or malformed
   Host-supplied input rather than inventing defaults.
3. Prove Native Messaging framing, no-focus behavior, binding/query message
   handling, and receipt/idempotency failures through deterministic tests.
4. Re-run all companion tests to GREEN.

### Task 4: Add public-pack and fresh-consumer evidence without release

**Files:**

- Modify: `scripts/fresh-consumer-install.test.mjs`
- Modify: `scripts/pack-publish-artifact.mjs` only if a generic pack invariant
  requires it
- Create: `packages/personal-chrome-companion/README.md`

1. Include the companion tarball in the existing fresh-consumer fixture.
2. Assert the installed package has exactly the declared extension/helper
   closure and runs the helper entrypoint without source-tree resolution.
3. State macOS/Linux developer support and the signed Chrome Web Store,
   Windows, installer, and Host-adoption gaps explicitly.
4. Run `pnpm test:fresh-consumer`; this packs and installs locally but never
   invokes `npm publish`.

### Task 5: Verify in CI without adding a publication path

**Files:**

- Create: `.github/workflows/personal-chrome-companion-ci.yml`

1. Add a pull-request/push validation workflow scoped to companion and shared
   pack/fresh-consumer inputs.
2. Run typecheck, tests, build, and fresh-consumer evidence only.
3. Assert the workflow contains no `npm publish`, npm token, provenance
   publish, Chrome Web Store, or platform installer action.

### Task 6: Delivery evidence

1. Run focused companion tests, package build/typecheck, fresh-consumer, and
   `git diff --check`.
2. Obtain a non-author exact-HEAD review focused on authority boundaries,
   source closure, least privilege, and accidental-release absence.
3. Open a PR; do not merge/publish. Report its exact SHA, tests, and remaining
   signed-distribution/Windows/Host-adoption boundaries.

## Verified commands

```sh
pnpm --filter @clowder-ai/personal-chrome-companion typecheck
pnpm --filter @clowder-ai/personal-chrome-companion test
pnpm --filter @clowder-ai/personal-chrome-companion build
pnpm test:fresh-consumer
git diff --check
```

The repository has no general formatter script. These commands are grounded in
the root package scripts and existing F292 package conventions; no guessed
format command is included.

## Open questions

- **Technical:** When the candidate is approved for release, whether Cat Café
  consumes the packed protocol directly or mirrors it through a generated
  locked artifact. Resolve in the cross-repository adoption PR, not by adding a
  fallback protocol here.
- **Value:** Chrome Web Store public versus invite-only release, signed artifact
  identity, and Windows support require CVO approval. They are intentionally
  outside this candidate.
