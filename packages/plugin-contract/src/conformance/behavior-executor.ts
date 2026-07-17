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

export async function executeBehaviorCase(
  behaviorCase: BehaviorCase,
  adapter: BehaviorAdapter,
): Promise<BehaviorCaseReport> {
  await adapter.setup(behaviorCase.given);

  const targets = [...new Set(behaviorCase.expect.sideEffects.map(({ target }) => target))];
  const before = new Map<BehaviorTarget, unknown>();
  for (const target of targets) {
    before.set(target, await adapter.observe(target));
  }

  const verdict = await adapter.execute(behaviorCase.when);

  const after = new Map<BehaviorTarget, unknown>();
  for (const target of targets) {
    after.set(target, await adapter.observe(target));
  }

  const failures: string[] = [];
  if (verdict.status !== behaviorCase.expect.status) {
    failures.push(
      `status: expected ${behaviorCase.expect.status}, received ${verdict.status}`,
    );
  }
  if (verdict.errorCode !== behaviorCase.expect.errorCode) {
    failures.push(
      `errorCode: expected ${String(behaviorCase.expect.errorCode)}, received ${String(verdict.errorCode)}`,
    );
  }

  for (const assertion of behaviorCase.expect.sideEffects) {
    if (!assertionPassed(assertion, before.get(assertion.target), after.get(assertion.target))) {
      failures.push(`${assertion.target}: expected ${assertion.assertion}`);
    }
  }

  return {
    id: behaviorCase.id,
    passed: failures.length === 0,
    failures,
  };
}
