---
feature_ids:
  - C-1
topics:
  - plugin-contract
  - schema-codegen
  - conformance
doc_kind: implementation-plan
created: 2026-07-15
---

# Contract R4 Hardening Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the four R3 false-green modes by aligning the public messaging contract with the K-1 candidate, making behavioral fixtures executable data, enforcing semantic byte limits, and generating TypeScript from JSON Schema.

**Architecture:** JSON Schema remains the sole structural truth source. A dependency-free repository generator renders checked-in TypeScript projections and contract tables; CI compares generated output byte-for-byte. JSON Schema handles structural constraints, a package semantic validator handles UTF-8 byte budgets, and a separately-schema-validated behavior format supplies future loopback executors with structured setup, calls, verdicts, and side-effect assertions.

**Tech Stack:** TypeScript 5.7, JSON Schema 2020-12, Ajv 8, Node.js 20 test runner, pnpm workspace.

---

### Task 1: Capture the R3 regressions as failing tests

**Files:**
- Create: `packages/plugin-contract/src/conformance/schema-regressions.test.ts`
- Create: `packages/plugin-contract/src/validation/messaging-semantic.test.ts`
- Create: `packages/plugin-contract/src/conformance/behavior-fixture.test.ts`
- Modify: `packages/plugin-contract/package.json`

**Step 1: Write failing schema tests**

Assert that the messaging schema accepts the actual K-1 candidate draft, rejects a text element without `payload.text`, and rejects incoherent subscription states.

**Step 2: Write failing semantic-limit tests**

Assert rejection above 64 KiB per element and 256 KiB total while accepting boundary-safe payloads.

**Step 3: Write failing behavior-format tests**

Assert the committed behavior suite validates, then remove `when` or `expect.sideEffects` and assert rejection.

**Step 4: Run tests and verify RED**

Run: `pnpm --filter @clowder-ai/plugin-contract test`

Expected: failures show the current schema rejects K-1 shape, accepts invalid text/subscription states, lacks semantic validation, and has no behavior schema.

### Task 2: Align messaging schema and encode fail-closed states

**Files:**
- Modify: `packages/plugin-contract/src/schemas/messaging.schema.json`
- Modify: `packages/plugin-contract/fixtures/messaging/valid/*.json`
- Modify: `packages/plugin-contract/fixtures/messaging/invalid/*.json`

**Step 1: Align K-1 candidate structures**

Introduce structured provenance origins, draft/canonical provenance, `thread_handle|connector_binding` addresses, object audiences, and flat output-event unions. Preserve the external MessageHandle boundary for append calls; the kernel broker may adapt it to its internal `messageId` service input.

**Step 2: Encode element variants**

Make `MessageElement` a union where `text` requires `{text:string}` and all payloads are JSON objects. Require non-empty element arrays.

**Step 3: Encode subscription state union**

Use distinct normal, empty, and stale response definitions so invalid event/ack/stale combinations cannot validate.

**Step 4: Run schema tests and verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- schema-regressions`

Expected: all schema regression tests pass.

### Task 3: Add the shared semantic validator

**Files:**
- Create: `packages/plugin-contract/src/validation/messaging-semantic.ts`
- Create: `packages/plugin-contract/src/validation/index.ts`
- Modify: `packages/plugin-contract/src/conformance/runner.ts`
- Modify: `packages/plugin-contract/src/index.ts`

**Step 1: Implement UTF-8 byte accounting**

Read byte limits from schema metadata, reject non-serializable payloads, reject an element payload above 64 KiB, and reject aggregate element payload above 256 KiB.

**Step 2: Integrate with fixture validation**

For messaging fixtures, a document is valid only if both schema and semantic validation pass; invalid fixtures may fail either layer.

**Step 3: Export the validator**

Expose the same semantic validator to host and SDK consumers so conformance and runtime do not duplicate limits.

**Step 4: Run semantic tests and verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- messaging-semantic`

Expected: boundary and overflow tests pass.

### Task 4: Make behavioral fixtures machine-executable

**Files:**
- Create: `packages/plugin-contract/src/schemas/behavior-fixture.schema.json`
- Rewrite: `packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json`
- Modify: `packages/plugin-contract/src/conformance/runner.ts`

**Step 1: Define scenario schema**

Require `_meta.executor`, domain and contract version plus per-case `given`, structured `when.operation/input`, and `expect.status/errorCode/sideEffects[]`.

**Step 2: Rewrite nine messaging cases**

Provide actual caller/grant/handle/state setup, operation inputs, expected verdicts, and structured zero-mutation/event/ledger or round-trip assertions.

**Step 3: Validate before counting**

Make the runner fail on malformed behavior files and report per-file executor and validated case count before skipping execution.

**Step 4: Run behavior tests and verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- behavior-fixture`

Expected: committed suite passes; missing input or side effects fails.

### Task 5: Replace shallow parity with schema-to-TypeScript generation

**Files:**
- Create: `packages/plugin-contract/src/codegen/generate-contract.ts`
- Create: `packages/plugin-contract/src/generated/contract.generated.ts`
- Create: `packages/plugin-contract/src/codegen/generate-contract.test.ts`
- Modify: `packages/plugin-contract/src/schemas/manifest.schema.json`
- Modify: `packages/plugin-contract/src/schemas/messaging.schema.json`
- Modify: `packages/plugin-contract/src/types/index.ts`
- Modify: `packages/plugin-contract/src/types/capability.ts`
- Modify: `packages/plugin-contract/src/types/data-class.ts`
- Delete: `packages/plugin-contract/src/types/common.ts`
- Delete: `packages/plugin-contract/src/types/manifest.ts`
- Delete: `packages/plugin-contract/src/types/messaging.ts`
- Delete: `packages/plugin-contract/src/conformance/parity-check.ts`
- Modify: `packages/plugin-contract/package.json`
- Modify: `.github/workflows/contract-ci.yml`

**Step 1: Write generator tests**

Assert generated `PluginFeature.capabilities` is the literal Capability union, required/optional fields match schema, and a schema mutation changes generated output.

**Step 2: Implement deterministic generator**

Render schema `$defs`, unions, object properties, arrays, refs, constants, capability layers, data strategy tables, and messaging bounds without third-party dependencies.

**Step 3: Switch public exports to generated types**

Keep only runtime helper functions handwritten; derive their types and tables from the generated artifact.

**Step 4: Add CI freshness check**

`generate:check` renders in memory and fails if checked-in generated output differs. Replace the shallow parity command and step.

**Step 5: Run generator tests and verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- generate-contract`

Expected: generator tests and freshness check pass.

### Task 6: Full verification, commit, push, and review handoff

**Files:**
- Verify all changed files above

**Step 1: Run full local gate**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract generate:check
pnpm --filter @clowder-ai/plugin-contract typecheck
pnpm --filter @clowder-ai/plugin-contract test
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/plugin-contract conformance
git diff --check
```

Expected: every command exits 0; conformance reports all schema and behavior fixture files structurally valid, with loopback execution explicitly skipped.

**Step 2: Commit with Why in the body**

Commit the coherent R4 hardening change on `feat/pr-1-contract-bootstrap` and push without changing draft status.

**Step 3: Request independent review**

Ask `@codex` to review the pushed SHA, emphasizing codegen freshness, K-1 shape alignment, semantic byte limits, and machine-executable behavioral scenarios.
