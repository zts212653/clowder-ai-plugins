---
feature_ids:
  - C-1
  - G-0
topics:
  - plugin-contract
  - signed-contract-values
  - behavior-fixtures
  - schema-codegen
doc_kind: implementation-plan
created: 2026-07-16
---

# G-0 / C-1 Signed Contract Reconciliation Plan

**Goal:** Make the G-0 values signed on 2026-07-15 mechanically visible in the C-1 package without expanding the package into a Host policy or retention-query surface.

**Architecture:** JSON Schema remains the single source for signed capability and replay metadata. The checked-in TypeScript projection is regenerated from those schemas and generation fails when metadata drifts from its structural source. The closed loopback behavior vocabulary carries grant/preset/replay invariants that JSON Schema cannot enforce. Host-only persistence and query obligations remain explicit follow-up inputs rather than invented package APIs.

**Tech Stack:** TypeScript 5.7, JSON Schema 2020-12, Ajv 8, Node.js 20 test runner, pnpm workspace.

---

### Task 1: Capture signed metadata and behavior coverage as failing tests

**Files:**
- Modify: `packages/plugin-contract/src/codegen/generate-contract.test.ts`
- Modify: `packages/plugin-contract/src/conformance/behavior-fixture.test.ts`
- Modify: `packages/plugin-contract/src/conformance/manifest-regressions.test.ts`

**Steps:**
1. Assert generated output exposes the signed 7-day messaging replay default and rejects metadata drift.
2. Assert manifest metadata records the signed capability state, L1-only first-party presets, empty default whisper grants, and protocol-intrinsic lifecycle callbacks.
3. Assert the behavior suite contains the exact signed policy cases, with the expected grants, verdicts, and side-effect or policy-state oracles.
4. Run the focused tests and confirm RED for the missing metadata/cases.

### Task 2: Encode signed contract metadata in schema truth sources

**Files:**
- Modify: `packages/plugin-contract/src/schemas/manifest.schema.json`
- Modify: `packages/plugin-contract/src/schemas/messaging.schema.json`
- Modify: `packages/plugin-contract/src/codegen/generate-contract.ts`
- Modify: `packages/plugin-contract/src/index.ts`
- Regenerate: `packages/plugin-contract/src/generated/contract.generated.ts`

**Steps:**
1. Mark the capability vocabulary signed, state that lifecycle callbacks are protocol-intrinsic, and declare the derived first-party preset and default-whisper policies without adding new manifest fields.
2. Add signed replay-retention metadata with a 7-day default to the messaging schema.
3. Validate the metadata shape and render `MESSAGING_REPLAY_DEFAULTS` from the schema.
4. Replace stale package-level candidate wording for the signed C-1 subset and regenerate the projection.

### Task 3: Close the behavior-fixture policy vocabulary

**Files:**
- Modify: `packages/plugin-contract/src/schemas/behavior-fixture.schema.json`
- Modify: `packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json`
- Modify: `packages/plugin-contract/src/conformance/behavior-fixture.test.ts`

**Steps:**
1. Add only the operation and assertion vocabulary needed to express grant denial, first-party preset policy, empty default whisper grants, denied callback delivery, and replay-event deletion isolation.
2. Add the signed cases: L2 preset rejection, visible/revocable L1 preset, out-of-grant whisper rejection, append without grant, denied `onMessage`, the complete required-permission matrix, and replay deletion preserving canonical messages.
3. Keep `executor: loopback`; P-2 still owns execution, while C-1 owns a structurally executable oracle.

### Task 4: Verify, push the repair commit, and request delta review

**Steps:**
1. Run focused GREEN tests, generation freshness, package typecheck/test/conformance, and `git diff --check`.
2. Inspect the diff for Host-surface expansion, generated-file hand edits, and stale candidate wording.
3. Commit with the rationale and Sol identity signature.
4. Push the exact commit as a fast-forward update to `fork/feat/pr-1-contract-bootstrap`.
5. Update tracking and the persistent G-0 task, then route the new exact SHA to Terra for delta review. Do not merge or publish.

### Deferred non-blocking inputs

- C-2: `docName.maxLength=512`, parser fallback semantics, payload-free ingress trace default 7 days, sensitive-payload non-persistence, and governance/settlement ledger semantics.
- Host/K: a queryable retention state surface and the Host enforcement corresponding to behavior fixtures.
