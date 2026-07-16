---
feature_ids:
  - P-2
  - M0
topics:
  - plugin-contract
  - conformance
  - loopback
  - messaging
doc_kind: implementation-plan
created: 2026-07-16
---

# P-2 Messaging Loopback Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the contract runner's 16-case “execution skipped” result with deterministic, fail-closed execution of every signed messaging behavior fixture.

**Architecture:** The behavior JSON Schema remains the sole fixture vocabulary. Code generation projects its types into `contract.generated.ts`; a reusable executor captures before/after observations and evaluates the schema-owned assertions; a deterministic in-memory loopback adapter implements the messaging semantics needed by the signed cases. This is P-2, the first independently testable M0 slice—it does not claim that the cross-process SDK transport or Host Broker is complete.

**Tech Stack:** TypeScript 5.7, Node.js 20 test runner, Ajv 8, pnpm 9, JSON Schema 2020-12.

---

## Scope and truth-source boundary

- `packages/plugin-contract/src/schemas/behavior-fixture.schema.json` owns operation, verdict, target, and assertion vocabulary.
- `packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json` owns the 16 signed scenarios and their expected observations.
- `packages/plugin-contract/src/conformance/behavior-executor.ts` owns generic fixture orchestration and assertion evaluation.
- `packages/plugin-contract/src/conformance/messaging-loopback-adapter.ts` owns the deterministic reference-host semantics used by P-2.
- `packages/plugin-contract/src/conformance/runner.ts` owns discovery, schema validation, execution, and process exit status.
- P-2 does not add handshake, JSON-RPC/stdio framing, process supervision, or production Host persistence. Those belong to the subsequent M0 SDK/runtime and core Host Broker plans.

### Task 0: Require the frozen beta.1 publication before implementation

**Files:**
- Verify only

- [ ] **Step 1: Query the exact registry version**

Run:

```bash
npm view @clowder-ai/plugin-contract@0.1.0-beta.1 \
  name version dist.integrity dist-tags --json
```

Expected: exact version `0.1.0-beta.1`, a non-empty `sha512-...` integrity, `next === "0.1.0-beta.1"`, and `latest !== "0.1.0-beta.1"`.

- [ ] **Step 2: Stop if the publication gate is not closed**

If the query returns `E404`, an empty integrity, or incorrect dist-tags, stop. P-2 may remain planned on its feature branch, but implementation must not proceed against an unpublished contract artifact.

### Task 1: Generate behavior-fixture types from the schema

**Files:**
- Modify: `packages/plugin-contract/src/codegen/generate-contract.ts`
- Modify: `packages/plugin-contract/src/codegen/generate-contract.test.ts`
- Regenerate: `packages/plugin-contract/src/generated/contract.generated.ts`

- [ ] **Step 1: Write the failing code-generation tests**

Add:

```ts
test('generated contract projects behavior fixture operations and assertions', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type BehaviorFixture =/);
  assert.match(source, /export type BehaviorCase =/);
  assert.match(source, /readonly operation: 'send'/);
  assert.match(source, /readonly operation: 'deleteReplayEvents'/);
  assert.match(source, /export type SideEffectAssertion =/);
  assert.match(source, /'unchanged' \| 'none' \| 'state_equals' \| 'round_trip' \| 'matches'/);
});

test('behavior capability names resolve to the manifest-owned Capability type', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type CapabilityName = Capability;/);
  assert.doesNotMatch(source, /export type CapabilityName = unknown;/);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- generate-contract
```

Expected: FAIL because `ContractSchemas` does not load the behavior schema and no behavior types are generated.

- [ ] **Step 3: Extend the generator input and external-ref resolver**

Change the schema bundle to:

```ts
export interface ContractSchemas {
  readonly manifest: JsonSchema;
  readonly messaging: JsonSchema;
  readonly behavior: JsonSchema;
}

export async function loadContractSchemas(): Promise<ContractSchemas> {
  return {
    manifest: await readSchema(new URL('../schemas/manifest.schema.json', import.meta.url)),
    messaging: await readSchema(new URL('../schemas/messaging.schema.json', import.meta.url)),
    behavior: await readSchema(new URL('../schemas/behavior-fixture.schema.json', import.meta.url)),
  };
}
```

Resolve the behavior schema's only external reference without copying the capability enum:

```ts
const MANIFEST_CAPABILITY_REF =
  'https://clowder-ai.dev/schemas/manifest/v0.1#/$defs/Capability';

function refName(ref: string): string {
  if (ref === MANIFEST_CAPABILITY_REF) return 'Capability';

  const marker = '#/$defs/';
  if (!ref.startsWith(marker)) {
    throw new Error(`Unsupported schema reference: ${ref}`);
  }
  return decodeURIComponent(ref.slice(marker.length));
}
```

Append the behavior definitions and root type after the messaging definitions:

```ts
...renderDefinitions(schemas.behavior),
'',
`export type BehaviorFixture = ${renderType(schemas.behavior)};`,
```

Update the generated-file banner to name all three source schemas.

- [ ] **Step 4: Generate and verify GREEN**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract generate
pnpm --filter @clowder-ai/plugin-contract test -- generate-contract
pnpm --filter @clowder-ai/plugin-contract generate:check
```

Expected: focused tests pass and the checked-in projection is current.

- [ ] **Step 5: Commit the schema projection**

```bash
git add packages/plugin-contract/src/codegen \
  packages/plugin-contract/src/generated/contract.generated.ts
git commit -m "feat(contract): project behavior fixture types" \
  -m "Why: P-2 must consume the schema-owned operation and assertion vocabulary without hand-maintained duplicate types." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 2: Add a generic fail-closed behavior executor

**Files:**
- Create: `packages/plugin-contract/src/conformance/behavior-executor.ts`
- Create: `packages/plugin-contract/src/conformance/behavior-executor.test.ts`
- Modify: `packages/plugin-contract/src/conformance/index.ts`

- [ ] **Step 1: Write failing executor tests**

Cover status mismatch, error-code mismatch, mutation detection, empty-target detection, and value comparison:

```ts
test('unchanged compares adapter observations before and after execution', async () => {
  const adapter = new ScriptedAdapter({
    before: { messages: [{ messageId: 'message-1', revision: 1 }] },
    after: { messages: [{ messageId: 'message-1', revision: 2 }] },
    verdict: { status: 'error', errorCode: 'CONFLICT' },
  });

  const report = await executeBehaviorCase(conflictCase, adapter);

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /messages.*expected unchanged/);
});

test('none rejects a non-empty observation', async () => {
  const adapter = new ScriptedAdapter({
    before: { output_events: [] },
    after: { output_events: [{ eventId: 'event-1' }] },
    verdict: { status: 'error', errorCode: 'PERMISSION' },
  });

  const report = await executeBehaviorCase(rawThreadCase, adapter);

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /output_events.*expected none/);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-executor
```

Expected: FAIL because the executor module does not exist.

- [ ] **Step 3: Define the adapter and report boundary**

Implement:

```ts
import { isDeepStrictEqual } from 'node:util';
import type {
  BehaviorCase,
  FixtureOperation,
  FixtureSetup,
  MessagingErrorCode,
  SideEffectAssertion,
} from '../generated/contract.generated.js';

export type BehaviorTarget = SideEffectAssertion['target'];

export interface BehaviorVerdict {
  readonly status: 'success' | 'error';
  readonly errorCode?: MessagingErrorCode;
}

export interface BehaviorAdapter {
  setup(given: FixtureSetup): Promise<void>;
  observe(target: BehaviorTarget): Promise<unknown>;
  execute(operation: FixtureOperation): Promise<BehaviorVerdict>;
}

export interface BehaviorCaseReport {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}
```

`executeBehaviorCase` must:

1. call `setup`;
2. capture every asserted target before execution;
3. execute exactly once;
4. capture every asserted target after execution;
5. compare status and error code;
6. evaluate every assertion;
7. return all failures instead of throwing on the first mismatch.

Use these exact assertion rules:

```ts
function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

function assertionPassed(
  assertion: SideEffectAssertion,
  before: unknown,
  after: unknown,
): boolean {
  switch (assertion.assertion) {
    case 'unchanged':
      return isDeepStrictEqual(after, before);
    case 'none':
      return isEmpty(after);
    case 'state_equals':
    case 'round_trip':
    case 'matches':
      return isDeepStrictEqual(after, assertion.value);
  }
}
```

- [ ] **Step 4: Export and verify GREEN**

Export the executor types and functions from `src/conformance/index.ts`, then run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-executor
pnpm --filter @clowder-ai/plugin-contract typecheck
```

Expected: executor tests and typecheck pass.

- [ ] **Step 5: Commit the generic executor**

```bash
git add packages/plugin-contract/src/conformance/behavior-executor*
git add packages/plugin-contract/src/conformance/index.ts
git commit -m "feat(contract): add behavior fixture executor" \
  -m "Why: host and SDK adapters need one fail-closed evaluator for the signed oracle instead of each interpreting assertions differently." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 3: Implement the deterministic messaging loopback adapter

**Files:**
- Create: `packages/plugin-contract/src/conformance/messaging-loopback-state.ts`
- Create: `packages/plugin-contract/src/conformance/messaging-loopback-adapter.ts`
- Create: `packages/plugin-contract/src/conformance/messaging-loopback-adapter.test.ts`

- [ ] **Step 1: Write one failing test per operation family**

The focused suite must cover:

```ts
const operationFamilies = [
  'send',
  'appendElements',
  'read/ack/snapshot',
  'applyGrantPreset/revokeGrant',
  'deliverOnMessage',
  'checkPermissionMatrix',
  'deleteReplayEvents',
] as const;
```

For every family, load at least one committed fixture case, execute it through `executeBehaviorCase`, and require `passed === true`. Add a controlled mutation for each error family:

```ts
test('stale baseRevision cannot mutate a canonical message', async () => {
  const report = await runCommittedCase('base-revision-conflict-zero-change');
  assert.deepEqual(report, {
    id: 'base-revision-conflict-zero-change',
    passed: true,
    failures: [],
  });
});

test('removing the append grant still returns PERMISSION with zero mutation', async () => {
  const report = await runCommittedCase('append-without-grant-rejected');
  assert.equal(report.passed, true);
});
```

- [ ] **Step 2: Run the focused suite to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- messaging-loopback-adapter
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Build normalized in-memory state**

`MessagingLoopbackState` must normalize fixture setup into explicit collections:

```ts
export interface MessagingLoopbackState {
  callerId: string;
  grants: Set<string>;
  handles: Map<string, FixtureHandle>;
  messages: Map<string, Record<string, unknown>>;
  outputEvents: Record<string, unknown>[];
  ledger: Map<string, Record<string, unknown>>;
  subscriptions: Map<string, Record<string, unknown>>;
  replayEvents: Record<string, unknown>[];
  grantState: Map<string, { visible: boolean; granted: boolean }>;
  observations: Map<BehaviorTarget, unknown>;
}
```

Never retain or compare fixture input objects by reference. Use `structuredClone` at setup and observation boundaries so `unchanged` assertions detect real mutation.

- [ ] **Step 4: Implement operation dispatch with host-owned checks**

Use an exhaustive switch:

```ts
async execute(operation: FixtureOperation): Promise<BehaviorVerdict> {
  switch (operation.operation) {
    case 'send':
      return this.send(operation.input);
    case 'appendElements':
      return this.appendElements(operation.input);
    case 'subscribe':
      return this.subscribe(operation.input);
    case 'read':
      return this.read(operation.input);
    case 'ack':
      return this.ack(operation.input);
    case 'snapshot':
      return this.snapshot(operation.input);
    case 'applyGrantPreset':
      return this.applyGrantPreset(operation.input);
    case 'revokeGrant':
      return this.revokeGrant(operation.input);
    case 'deliverOnMessage':
      return this.deliverOnMessage(operation.input);
    case 'checkPermissionMatrix':
      return this.checkPermissionMatrix(operation.input);
    case 'deleteReplayEvents':
      return this.deleteReplayEvents(operation.input);
    default:
      return assertNever(operation);
  }
}
```

Each handler must enforce the signed invariant before mutation:

- `send`: require `messaging.send`, a caller-owned host handle, no system audience, caller-owned plugin origin, in-grant whisper targets, and same-thread `replyTo`.
- `appendElements`: require `messaging.appendElements`, caller-owned message handle, matching base revision, and no epistemic upgrade.
- `read/ack/snapshot`: keep cursor and ack token subscription-local; stale reads return no events and an exact snapshot resume observation.
- grant preset: reject every L2 capability; L1 preset grants remain visible and revocable; default whisper targets remain empty.
- `deliverOnMessage`: require `message.event.subscribe`.
- permission matrix: require all 17 unique schema-owned capabilities and the signed L0/L1/L2/preset mapping.
- replay deletion: delete only replay events; canonical messages are a different collection and remain unchanged.

Do not add fallback success paths. Unknown handles, messages, subscriptions, or operations fail closed with `NOT_FOUND` or `VALIDATION`.

- [ ] **Step 5: Verify all 16 committed cases**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- messaging-loopback-adapter
```

Expected: all 16 committed cases pass; controlled mutations fail at the intended invariant.

- [ ] **Step 6: Commit the reference adapter**

```bash
git add packages/plugin-contract/src/conformance/messaging-loopback-*
git commit -m "feat(contract): execute messaging invariants in loopback" \
  -m "Why: M0 needs a deterministic reference host that proves the signed fixture outcomes before production Broker and SDK adapters claim conformance." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 4: Make conformance execution mandatory

**Files:**
- Modify: `packages/plugin-contract/src/conformance/runner.ts`
- Modify: `packages/plugin-contract/src/conformance/behavior-fixture.test.ts`

- [ ] **Step 1: Write the runner integration test**

Export a testable `runConformance()` function and capture its result:

```ts
test('conformance executes every loopback behavior case', async () => {
  const report = await runConformance();

  assert.equal(report.contractFixtures.passed, 25);
  assert.equal(report.contractFixtures.total, 25);
  assert.equal(report.behaviorCases.passed, 16);
  assert.equal(report.behaviorCases.total, 16);
  assert.deepEqual(report.failures, []);
});
```

Add a mutation test that replaces one adapter observation and requires a non-zero behavior failure count. This prevents the runner from returning to validate-and-skip.

- [ ] **Step 2: Run the integration test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-fixture
```

Expected: FAIL because the runner does not execute behavior cases or expose a report.

- [ ] **Step 3: Register the loopback executor fail-closed**

After schema validation, dispatch only registered executor names:

```ts
const behaviorAdapters = {
  loopback: () => new MessagingLoopbackAdapter(),
} as const;

const executorName = data._meta!.executor;
const createAdapter = behaviorAdapters[executorName];
if (!createAdapter) {
  failures.push(`${fixturePath}: unsupported behavior executor ${executorName}`);
  continue;
}

for (const behaviorCase of data.cases!) {
  const report = await executeBehaviorCase(behaviorCase, createAdapter());
  if (!report.passed) {
    failures.push(...report.failures.map((failure) => `${fixturePath}/${report.id}: ${failure}`));
  }
}
```

The CLI summary must become:

```text
✅ behavior/messaging/adversarial-invariants.json
   16/16 loopback behavior cases executed
```

Delete both “execution skipped” and “requires P-2” output paths. Any malformed fixture, unsupported executor, thrown adapter error, verdict mismatch, or assertion mismatch must contribute to exit code 1.

- [ ] **Step 4: Verify RED mutations and GREEN baseline**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-fixture
pnpm --filter @clowder-ai/plugin-contract conformance
```

Expected: tests pass; conformance reports 25/25 structural fixtures and 16/16 executed behavior cases.

- [ ] **Step 5: Commit mandatory execution**

```bash
git add packages/plugin-contract/src/conformance/runner.ts \
  packages/plugin-contract/src/conformance/behavior-fixture.test.ts
git commit -m "feat(contract): require loopback behavior execution" \
  -m "Why: structurally valid fixtures are not conformance until their signed outcomes and zero-mutation boundaries are actually exercised." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 5: Publish P-2 as a unique prerelease

**Files:**
- Modify: `packages/plugin-contract/package.json`
- Modify: `packages/plugin-contract/src/conformance/release-config.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Pin the next immutable artifact version**

Write a failing release-config assertion for package version `0.1.0-beta.2`, while preserving protocol `contractVersion: 0.1.0` and the `next` dist-tag policy.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- release-config
```

Expected: FAIL because the artifact is still `0.1.0-beta.1`.

- [ ] **Step 3: Bump package and lockfile only**

Set `packages/plugin-contract/package.json` to `0.1.0-beta.2`, then run:

```bash
pnpm install --lockfile-only
```

Do not change any fixture or manifest `contractVersion` away from `0.1.0`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- release-config
```

Expected: PASS and release guards still reserve `latest`.

- [ ] **Step 5: Commit the prerelease version**

```bash
git add packages/plugin-contract/package.json pnpm-lock.yaml \
  packages/plugin-contract/src/conformance/release-config.test.ts
git commit -m "chore(contract): prepare P-2 beta.2" \
  -m "Why: npm artifacts are immutable, so the executable conformance delta requires a unique prerelease while the signed protocol remains v0.1.0." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 6: Full verification and review handoff

**Files:**
- Verify all files above

- [ ] **Step 1: Run the complete repository gate**

```bash
pnpm --filter @clowder-ai/plugin-contract generate:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm conformance
git diff --check
```

Expected:

- generated projection current;
- typecheck/lint/build exit 0;
- all unit tests pass;
- 25/25 structural contract fixtures pass;
- 16/16 behavior cases execute and pass;
- no “execution skipped” text remains;
- worktree contains no generated tarball or root media artifact.

- [ ] **Step 2: Pack and inspect the exact artifact**

```bash
pnpm --filter @clowder-ai/plugin-contract pack --json --ignore-scripts
```

Expected: `@clowder-ai/plugin-contract@0.1.0-beta.2`, non-empty `sha512-...` integrity, generated types, schemas, fixtures, and no source-control/private-governance data.

- [ ] **Step 3: Run the fallback-layer audit**

Run the repository-available fallback checker if present. Otherwise inspect the P-2 diff:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n 'catch|\\?\\?|\\|\\||else if' \
  packages/plugin-contract/src/conformance
```

If any single file adds three or more fallback layers, stop and justify why each layer cannot be removed before requesting review.

- [ ] **Step 4: Push and request independent review**

Push `feat/m0-standalone-loopback`, open a PR against upstream `main`, register PR tracking immediately, and request cross-family review. The review packet must call out:

- schema-generated behavior types;
- fail-closed executor registry;
- all 16 signed cases executed;
- mutation resistance against skip/no-op/hollow adapters;
- strict non-claim that P-2 alone completes standalone I/O or Host Broker M0.

- [ ] **Step 5: Preserve the publication boundary**

Do not merge or publish `0.1.0-beta.2` until exact-head review, required CI, and explicit merge/publication authorization all cover the final SHA. After publication, independently verify exact version, `dist.integrity`, `next === 0.1.0-beta.2`, and `latest !== 0.1.0-beta.2`.
