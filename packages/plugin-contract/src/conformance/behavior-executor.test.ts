import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BehaviorCase,
  FixtureSetup,
  SideEffectAssertion,
} from '../generated/contract.generated.js';
import {
  executeBehaviorCase,
  type BehaviorAdapter,
  type BehaviorTarget,
  type BehaviorVerdict,
} from './behavior-executor.js';

class ScriptedAdapter implements BehaviorAdapter {
  readonly setupCalls: FixtureSetup[] = [];
  executeCalls = 0;
  private executed = false;

  constructor(
    private readonly before: Readonly<Record<string, unknown>>,
    private readonly after: Readonly<Record<string, unknown>>,
    private readonly verdict: BehaviorVerdict,
  ) {}

  async setup(given: FixtureSetup): Promise<void> {
    this.setupCalls.push(given);
  }

  async observe(target: BehaviorTarget): Promise<unknown> {
    return structuredClone((this.executed ? this.after : this.before)[target]);
  }

  async execute(): Promise<BehaviorVerdict> {
    this.executeCalls += 1;
    this.executed = true;
    return this.verdict;
  }
}

function makeCase(
  sideEffects: readonly SideEffectAssertion[],
  expected: { readonly status: 'success' | 'error'; readonly errorCode?: 'PERMISSION' | 'CONFLICT' },
): BehaviorCase {
  return {
    id: 'executor-case',
    invariant: 'the generic executor evaluates the signed oracle',
    given: {
      caller: { pluginInstanceId: 'plugin-a' },
      grants: [],
      handles: {},
      state: {},
    },
    when: {
      operation: 'send',
      input: {
        address: {},
        idempotencyKey: 'executor-case',
        payload: {},
      },
    },
    expect: { ...expected, sideEffects },
  };
}

test('unchanged compares adapter observations before and after execution', async () => {
  const adapter = new ScriptedAdapter(
    { messages: [{ messageId: 'message-1', revision: 1 }] },
    { messages: [{ messageId: 'message-1', revision: 2 }] },
    { status: 'error', errorCode: 'CONFLICT' },
  );

  const report = await executeBehaviorCase(
    makeCase([{ target: 'messages', assertion: 'unchanged' }], {
      status: 'error',
      errorCode: 'CONFLICT',
    }),
    adapter,
  );

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /messages.*expected unchanged/);
  assert.equal(adapter.executeCalls, 1);
  assert.equal(adapter.setupCalls.length, 1);
});

test('none rejects a non-empty observation', async () => {
  const adapter = new ScriptedAdapter(
    { output_events: [] },
    { output_events: [{ eventId: 'event-1' }] },
    { status: 'error', errorCode: 'PERMISSION' },
  );

  const report = await executeBehaviorCase(
    makeCase([{ target: 'output_events', assertion: 'none' }], {
      status: 'error',
      errorCode: 'PERMISSION',
    }),
    adapter,
  );

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /output_events.*expected none/);
});

test('status and error-code mismatches are reported together', async () => {
  const adapter = new ScriptedAdapter(
    { messages: [] },
    { messages: [] },
    { status: 'success', errorCode: 'CONFLICT' },
  );

  const report = await executeBehaviorCase(
    makeCase([{ target: 'messages', assertion: 'unchanged' }], {
      status: 'error',
      errorCode: 'PERMISSION',
    }),
    adapter,
  );

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /status.*expected error.*received success/);
  assert.match(report.failures.join('\n'), /errorCode.*expected PERMISSION.*received CONFLICT/);
});

test('value-bearing assertions compare the observed value deeply', async () => {
  const expected = { visible: true, capabilities: ['messaging.send'] };
  const adapter = new ScriptedAdapter(
    { grant_state: null },
    { grant_state: structuredClone(expected) },
    { status: 'success' },
  );

  const report = await executeBehaviorCase(
    makeCase(
      [{ target: 'grant_state', assertion: 'state_equals', value: expected }],
      { status: 'success' },
    ),
    adapter,
  );

  assert.deepEqual(report, { id: 'executor-case', passed: true, failures: [] });
});
