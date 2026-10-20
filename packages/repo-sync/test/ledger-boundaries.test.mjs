import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLedger } from '../src/ledger.mjs';

const pair = { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) };
function ledger(delivery) {
  return {
    accepted: pair,
    initial: pair,
    latest: pair.upstream,
    queue: [],
    events: [],
    issues: {},
    activeId: delivery?.id ?? null,
    deliveries: delivery ? [delivery] : [],
  };
}
test('unknown or duplicate delivery identity and a dangling active ID fail closed', () => {
  assert.throws(() => assertLedger(ledger({ id: 'c'.repeat(24), status: 'UNKNOWN', base: pair, candidate: null })), {
    code: 'LEDGER_INVALID',
  });
  assert.throws(() => assertLedger({ ...ledger(), activeId: 'd'.repeat(24) }), { code: 'LEDGER_INVALID' });
  const complete = {
    id: 'c'.repeat(24),
    status: 'COMPLETE',
    base: pair,
    candidate: pair.internal,
    acceptedInternal: pair.internal,
  };
  const value = ledger(complete);
  value.deliveries.push(complete);
  assert.throws(() => assertLedger(value), { code: 'LEDGER_INVALID' });
});
test('waiting approval requires the published candidate, its passed checks and a PR reference', () => {
  assert.throws(
    () => assertLedger(ledger({ id: 'c'.repeat(24), status: 'WAITING_APPROVAL', base: pair, candidate: null })),
    { code: 'LEDGER_INVALID' },
  );
});
