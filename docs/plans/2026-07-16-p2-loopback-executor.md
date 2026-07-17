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

**Goal:** Replace the contract runner's “execution skipped” result with deterministic, fail-closed execution of every signed messaging behavior fixture; the initial 16-case set grows to 18 through review hardening.

**Architecture:** The behavior JSON Schema remains the sole fixture vocabulary. Code generation projects its types into `contract.generated.ts`; a reusable executor captures before/after observations and evaluates the schema-owned assertions; a deterministic in-memory loopback adapter implements the messaging semantics needed by the signed cases. This is P-2, the first independently testable M0 slice—it does not claim that the cross-process SDK transport or Host Broker is complete.

**Tech Stack:** TypeScript 5.7, Node.js 24, npm 11.5.1+, Ajv 8, pnpm 9, JSON Schema 2020-12, GitHub Actions OIDC trusted publishing.

---

## Scope and truth-source boundary

- `packages/plugin-contract/src/schemas/behavior-fixture.schema.json` owns operation, verdict, target, and assertion vocabulary.
- `packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json` owns the 18 signed scenarios and their expected observations (16 initial + 2 subscription-authorization review cases).
- `packages/plugin-contract/src/conformance/behavior-executor.ts` owns generic fixture orchestration and assertion evaluation.
- `packages/plugin-contract/src/conformance/messaging-loopback-adapter.ts` owns the deterministic reference-host semantics used by P-2.
- `packages/plugin-contract/src/conformance/runner.ts` owns discovery, schema validation, execution, and process exit status.
- P-2 does not add handshake, JSON-RPC/stdio framing, process supervision, or production Host persistence. Those belong to the subsequent M0 SDK/runtime and core Host Broker plans.

### Task 0: Require the frozen beta.1 publication before implementation

**Files:**
- Verify only

- [x] **Step 1: Query the exact registry version**

Run:

```bash
npm view @clowder-ai/plugin-contract@0.1.0-beta.1 \
  name version dist.integrity dist-tags --json
```

Expected:

- exact version `0.1.0-beta.1`;
- exact integrity `sha512-FT02Wl2AOkSvLSFVVE+bx6w8D0Izyqc797cAnNBrKH+QFPqYfeNSUFGWMy+BQwpR798zok3s2NxeEAeMmUFB8g==`;
- `next === "0.1.0-beta.1"`;
- `latest === "0.1.0-beta.1"` as the operator-approved npm bootstrap exception.

npm registry package metadata requires every published package to have a `latest` tag. Because beta.1 is the only published version, deleting `latest` is not a representable registry state and returns HTTP 400. This exception applies only to the first artifact; subsequent prereleases must preserve the pre-publish `latest` target byte-for-byte while moving only `next`.

- [x] **Step 2: Stop if the publication gate is not closed**

If the query returns `E404`, a different integrity, or either dist-tag differs from the accepted bootstrap state, stop. P-2 may remain planned on its feature branch, but implementation must not proceed against an unverified contract artifact.

### Task 1: Generate behavior-fixture types from the schema

**Files:**
- Modify: `packages/plugin-contract/src/codegen/generate-contract.ts`
- Modify: `packages/plugin-contract/src/codegen/generate-contract.test.ts`
- Regenerate: `packages/plugin-contract/src/generated/contract.generated.ts`

- [x] **Step 1: Write the failing code-generation tests**

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

- [x] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- generate-contract
```

Expected: FAIL because `ContractSchemas` does not load the behavior schema and no behavior types are generated.

- [x] **Step 3: Extend the generator input and external-ref resolver**

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

- [x] **Step 4: Generate and verify GREEN**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract generate
pnpm --filter @clowder-ai/plugin-contract test -- generate-contract
pnpm --filter @clowder-ai/plugin-contract generate:check
```

Expected: focused tests pass and the checked-in projection is current.

- [x] **Step 5: Commit the schema projection**

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

- [x] **Step 1: Write failing executor tests**

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

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-executor
```

Expected: FAIL because the executor module does not exist.

- [x] **Step 3: Define the adapter and report boundary**

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

- [x] **Step 4: Export and verify GREEN**

Export the executor types and functions from `src/conformance/index.ts`, then run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-executor
pnpm --filter @clowder-ai/plugin-contract typecheck
```

Expected: executor tests and typecheck pass.

- [x] **Step 5: Commit the generic executor**

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

#### Stateful Object Gate: authorization and canonical scope

R3 review exposed that ownership and capability checks alone do not authorize a
state transition. Every operation that consumes a host-issued handle must first
resolve the handle's canonical scope and bind every other state object involved
in the transition to that same scope.

| Truth | Writer / owner | Readers | Required invariant |
|---|---|---|---|
| capability layer | `manifest.schema.json` → generated `CAPABILITY_TABLE` | preset application, permission-matrix check, callback delivery | first-party presets are exactly the schema-owned L1 set; `onMessage` and `message.event.subscribe` remain distinct L2 grants |
| request handle reference | `messaging.schema.json#/$defs/MessageHandle` | append request validation before Host lookup | untrusted input is exactly `{ kind: "message", token: non-empty string }`; missing/wrong discriminants and extra properties are validation failures |
| host handle scope | fixture `handles[*].threadId` standing in for Host-issued state | send, subscribe, append, callback delivery | token exists, kind matches, caller owns it, and canonical `threadId` is non-empty before any mutation |
| canonical message scope | fixture `state.messages[*].threadId` standing in for Host message state | append and same-thread reply validation | resolved message exists and its `threadId` equals the authorized handle scope |
| callback envelope scope | `deliverOnMessage.input.envelope.threadId` | callback delivery | envelope `threadId` equals the authorized thread handle scope |
| grant projection | `grants` plus `grantState` | preset apply/revoke observations | validate the entire requested preset before changing either collection |

| Operation | Required capability | Scope transition | Mutation boundary |
|---|---|---|---|
| `send` | `messaging.send` | owned scoped thread/binding handle → new message in the same thread | create message/event/ledger only after all audience, provenance, and reply checks |
| `subscribe` | `message.event.subscribe` | owned scoped thread handle → subscription carrying the same thread | create subscription only after handle scope resolves |
| `appendElements` | `messaging.appendElements` | exact public message-handle reference → owned scoped Host handle → canonical message with the same `threadId` | revise message and emit event/ledger only after request shape, scope, revision, and epistemic checks |
| `deliverOnMessage` | `onMessage` | owned scoped thread handle + envelope with the same `threadId` | reference callback delivery has no collection mutation; every failed precondition preserves all observations |
| `applyGrantPreset` | n/a (policy operation) | requested capabilities must be a subset of generated L1 | update grants and visible grant state only after the whole request passes |

- [x] **Step 1: Write one failing test per operation family**

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

- [x] **Step 2: Run the focused suite to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- messaging-loopback-adapter
```

Expected: FAIL because the adapter does not exist.

- [x] **Step 3: Build normalized in-memory state**

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

- [x] **Step 4: Implement operation dispatch with host-owned checks**

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
- `appendElements`: require `messaging.appendElements`, a caller-owned message handle with resolved message/thread scope, a canonical message in that same thread, matching base revision, and no epistemic upgrade.
- `subscribe`: require `message.event.subscribe` and a caller-owned thread handle with a resolved canonical thread; persist that thread on the subscription projection.
- `read/ack/snapshot`: keep cursor and ack token subscription-local; stale reads return no events and an exact snapshot resume observation.
- grant preset: accept only the schema-owned L1 set; reject every L0/L2 capability before mutation; L1 preset grants remain visible and revocable; default whisper targets remain empty.
- `deliverOnMessage`: require `onMessage`, a caller-owned scoped thread handle, and an envelope whose canonical `threadId` matches that handle.
- permission matrix: require all 17 unique schema-owned capabilities and the signed L0/L1/L2/preset mapping.
- replay deletion: delete only replay events; canonical messages are a different collection and remain unchanged.

Do not add fallback success paths. Unknown handles, messages, subscriptions, or operations fail closed with `NOT_FOUND` or `VALIDATION`.

- [x] **Step 5: Verify all 18 committed cases**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- messaging-loopback-adapter
```

Expected: all 18 committed cases pass; controlled mutations fail at the intended invariant.

- [x] **Step 6: Commit the reference adapter**

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

- [x] **Step 1: Write the runner integration test**

Export a testable `runConformance()` function and capture its result:

```ts
test('conformance executes every loopback behavior case', async () => {
  const report = await runConformance();

  assert.equal(report.contractFixtures.passed, 25);
  assert.equal(report.contractFixtures.total, 25);
  assert.equal(report.behaviorCases.passed, 18);
  assert.equal(report.behaviorCases.total, 18);
  assert.deepEqual(report.failures, []);
});
```

Add a mutation test that replaces one adapter observation and requires a non-zero behavior failure count. This prevents the runner from returning to validate-and-skip.

- [x] **Step 2: Run the integration test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-fixture
```

Expected: FAIL because the runner does not execute behavior cases or expose a report.

- [x] **Step 3: Register the loopback executor fail-closed**

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
   18/18 loopback behavior cases executed
```

Delete both “execution skipped” and “requires P-2” output paths. Any malformed fixture, unsupported executor, thrown adapter error, verdict mismatch, or assertion mismatch must contribute to exit code 1.

- [x] **Step 4: Verify RED mutations and GREEN baseline**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- behavior-fixture
pnpm --filter @clowder-ai/plugin-contract conformance
```

Expected: tests pass; conformance reports 25/25 structural fixtures and 18/18 executed behavior cases.

- [x] **Step 5: Commit mandatory execution**

```bash
git add packages/plugin-contract/src/conformance/runner.ts \
  packages/plugin-contract/src/conformance/behavior-fixture.test.ts
git commit -m "feat(contract): require loopback behavior execution" \
  -m "Why: structurally valid fixtures are not conformance until their signed outcomes and zero-mutation boundaries are actually exercised." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

### Task 5: Prepare beta.2 with Node 24 and trusted publishing

**Files:**
- Modify: `.github/workflows/contract-ci.yml`
- Modify: `packages/plugin-contract/package.json`
- Modify: `packages/plugin-contract/src/conformance/release-config.test.ts`
- Create: `packages/plugin-contract/src/conformance/workflow-shell-syntax.test.ts`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Write failing release and workflow assertions**

Require all of the following in `release-config.test.ts` before changing production configuration:

```ts
test('P-2 publishes beta.2 while the protocol stays at signed v0.1', () => {
  assert.equal(contractPackage.version, '0.1.0-beta.2');
  assert.equal(contractPackage.private, false);
  assert.equal(messagingBehaviorSuite._meta?.contractVersion, '0.1.0');
});

test('CI and release use the trusted-publishing Node baseline', () => {
  assert.equal(releaseWorkflow.match(/node-version: '24'/g)?.length, 2);
  assert.match(releaseWorkflow, /^      id-token: write$/m);
  assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test('subsequent prereleases preserve the pre-publish latest target', () => {
  assert.match(releaseWorkflow, /PREVIOUS_LATEST:/);
  assert.match(releaseWorkflow, /distTags\.latest !== process\.env\.PREVIOUS_LATEST/);
  assert.doesNotMatch(releaseWorkflow, /npm\s+dist-tag\s+(?:add|rm)[^\n]*latest/i);
});
```

Keep the existing exact version/integrity and single-publish-path mutation guards. Add mutations that remove the previous-latest read, invert the comparison, reintroduce `NPM_TOKEN`, or add an `npm dist-tag` latest mutation; every mutation must be killed.

- [x] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- release-config
```

Expected: FAIL because the artifact is still beta.1, both jobs use Node 20, the workflow still supplies `NPM_TOKEN`, and the verifier assumes `latest` can be absent.

- [x] **Step 3: Move the workflow to OIDC and preserve latest**

In both jobs, set:

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: '24'
```

Keep `permissions.id-token: write`; remove every `NODE_AUTH_TOKEN`/`NPM_TOKEN` environment entry. Before publishing, read the current dist-tags and expose the exact target:

```bash
PREVIOUS_LATEST=$(npm view "$PACKAGE_NAME" dist-tags.latest --json | node --input-type=module -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input)));
')
printf 'previous_latest=%s\n' "$PREVIOUS_LATEST" >> "$GITHUB_OUTPUT"
```

Pass that output to the post-publish verifier as `PREVIOUS_LATEST`. Require `next === PACKAGE_VERSION` and `latest === PREVIOUS_LATEST`. Never run `npm dist-tag add/rm ... latest` from CI.

Retain PR #5's useful idempotence rule in corrected form: if the exact registry version already exists, skip `npm publish` only after exact version and integrity match; still run the tag verifier. This makes a post-publish rerun safe without pretending an integrity mismatch is recoverable.

- [x] **Step 4: Bump package and lockfile**

Set `packages/plugin-contract/package.json` to `0.1.0-beta.2`, then run:

```bash
pnpm install --lockfile-only
```

Do not change any fixture or manifest `contractVersion` away from `0.1.0`.

- [x] **Step 5: Add executable workflow shell validation**

Create `workflow-shell-syntax.test.ts` that extracts every YAML `run: |` block, normalizes indentation, and runs `bash -n` via `spawnSync`. Assert the exact number of multiline blocks so a newly added block cannot silently escape syntax validation.

- [x] **Step 6: Verify GREEN**

Run:

```bash
pnpm --filter @clowder-ai/plugin-contract test -- release-config
pnpm --filter @clowder-ai/plugin-contract test -- workflow-shell-syntax
```

Expected: PASS; release guards preserve the existing bootstrap `latest`, move only `next`, and contain no long-lived npm write token.

- [ ] **Step 7: Record the npm-side trusted publisher gate**

Before merge, require an npm Trusted Publisher for package `@clowder-ai/plugin-contract` with:

- provider: GitHub Actions;
- owner: `zts212653`;
- repository: `clowder-ai-plugins`;
- workflow filename: `contract-ci.yml`;
- allowed action: `npm publish`.

The PR may be reviewed without this external setting, but merge/publication remains blocked until the setting is independently confirmed. After confirmation, revoke the bootstrap GAT and remove the GitHub `NPM_TOKEN` secret.

- [x] **Step 8: Commit the prerelease and release-infrastructure delta**

```bash
git add .github/workflows/contract-ci.yml \
  packages/plugin-contract/package.json pnpm-lock.yaml \
  packages/plugin-contract/src/conformance/release-config.test.ts \
  packages/plugin-contract/src/conformance/workflow-shell-syntax.test.ts
git commit -m "chore(contract): prepare trusted P-2 beta.2" \
  -m "Why: executable conformance needs a unique artifact, while OIDC and an unchanged latest target remove the bootstrap token and prerelease-channel ambiguity." \
  -m "[砚砚/GPT-5.6 Sol🐾]"
```

#### Fresh-context review resolution

The pre-review scan anchored at `c933d32` produced five findings:

- **F1 / P2 — fixed:** all existing-subscription operations now consume one grant-and-owner guard; two distributable behavior cases lock missing-grant snapshot rejection and foreign replay-delete rejection.
- **F2 / P2 — fixed:** both the CLI and programmatic `runConformance()` report failures when contract fixtures or behavior cases are absent.
- **F3 / P3 — fixed:** the package exports `./conformance`, and its barrel exposes the generic executor plus deterministic loopback adapter without exposing the Ajv-backed repository runner.
- **F4 / P3 — retained gate:** npm Trusted Publisher configuration remains an independently verified pre-merge requirement because PR CI cannot exercise the push-only publish job.
- **F5 / P3 — bounded non-claim:** positive event production/read/ack flow remains a later C-2/M0 fixture expansion; P-2 proves the signed adversarial slice, not complete standalone messaging I/O.

The first automated PR review at `4614fab` added two `[FC:new]` P2 findings:

- **R1-1 — fixed:** `send` now accepts both schema-owned address variants and applies the same host-issued handle ownership check to `thread_handle` and `connector_binding`.
- **R1-2 — fixed:** replay deletion now removes only events explicitly associated with the authorized subscription; events for other subscriptions and unscoped events remain fail-closed.

The distributed fixture count remains 18. Existing case IDs, operations, invariants, and expected verdicts remain unchanged; the replay-deletion seed now explicitly carries its `subscriptionId`. Adapter-level regressions cover owned/foreign connector bindings and cross-subscription replay isolation.

The independent R1 delta review found one further P2 in the same handle family: an owned send address could lack a resolved `threadId` and still materialize a non-canonical message. The R2 fix requires a non-empty canonical thread target after kind/owner authorization and before any observation or collection mutation, for both `thread_handle` and `connector_binding`. Its regression locks `NOT_FOUND` plus zero messages, output events, and ledger entries. The replay regression also explicitly proves that an unscoped event is preserved fail-closed.

The maintainer exact-head R3 review exposed three remaining transitions that the earlier pointwise audit missed: callback delivery conflated `onMessage` with event subscription and discarded envelope scope; append bound message identity but not canonical message thread; and first-party presets used an L2 denylist instead of the signed L1 allowlist. Because this was the third round on the same adapter state object, the Stateful Object Gate above is now the controlling plan boundary. One scope resolver protects send/subscribe/append/callback transitions; append and callback additionally bind their canonical message/envelope thread before mutation; presets derive their complete allowlist from generated `CAPABILITY_TABLE.L1`. The audit also closes the sibling unscoped-subscribe path. Four focused regressions prove Red→Green while the distributed suite remains 18 cases with unchanged IDs, operations, invariants, and expected verdicts.

Cloud exact-head R4 found that append still treated an untrusted request reference as if it were the resolved Host handle: a valid stored token bypassed a missing or wrong request `kind`. The request-handle row in the Stateful Object Gate now distinguishes these truth sources. Append first validates the exact public `MessageHandle` shape from `messaging.schema.json`—including its discriminant, non-empty token, and closed-object boundary—then resolves the separate Host-owned `message_handle`. The sibling audit confirms `send.address` already validates its tagged union before Host lookup and no other operation has the same object-discriminant lookup path.

### Task 6: Full verification and review handoff

**Files:**
- Verify all files above

- [x] **Step 1: Run the complete repository gate**

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
- all unit tests pass (103/103 after maintainer R3 regressions, sibling scope audit, Cloud R4 request-shape guard, and exact-head npm-pack evidence guards);
- 25/25 structural contract fixtures pass;
- 18/18 behavior cases execute and pass;
- no “execution skipped” text remains;
- worktree contains no generated tarball or root media artifact.

- [x] **Step 2: Pack and inspect the exact artifact**

```bash
pack_dir=$(mktemp -d)
(
  cd packages/plugin-contract
  npm pack --json --ignore-scripts --pack-destination "$pack_dir"
)
```

Expected: `@clowder-ai/plugin-contract@0.1.0-beta.2`, non-empty `sha512-...` integrity, generated types, schemas, fixtures, and no source-control/private-governance data.

This local output is corroborating evidence only. The required CI job is the
release-candidate truth source: it checks out the exact PR head, verifies the
actual `git HEAD` and clean tracked tree after build, runs this npm pack path,
and uploads `plugin-contract-pack-evidence-<head-sha>` containing the SHA and
pack metadata. The durable review packet cites that machine artifact instead
of hard-coding a hash that a later commit can stale. Do not substitute
`pnpm pack`: for this package pnpm adds `LICENSE` and rewrites the packed
`package.json`, producing different contents and therefore a different
integrity even after the same build.

- [x] **Step 3: Run the fallback-layer audit**

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
- all 18 signed cases executed;
- mutation resistance against skip/no-op/hollow adapters;
- strict non-claim that P-2 alone completes standalone I/O or Host Broker M0.

- [ ] **Step 5: Preserve the publication boundary**

Do not merge or publish `0.1.0-beta.2` until exact-head review, required CI, npm Trusted Publisher configuration, and explicit merge/publication authorization all cover the final SHA. After publication, independently verify exact version, `dist.integrity`, `next === 0.1.0-beta.2`, and `latest === 0.1.0-beta.1` until a formal release explicitly moves it.
