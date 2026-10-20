import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { Receiver } from '../src/engine.mjs';
import { runExecution } from '../src/execution.mjs';
import { versionRepositories } from './version-fixtures.mjs';

test('a stale cancel page cannot cancel another active version delivery', async () => {
  let cancelled = false;
  const receiver = {
    status: async () => ({ active: { id: 'b'.repeat(24) } }),
    cancelVersion: async () => {
      cancelled = true;
    },
  };
  await assert.rejects(() => dispatch(receiver, { action: 'cancel-version', deliveryId: 'a'.repeat(24) }), {
    code: 'DELIVERY_CHANGED',
  });
  assert.equal(cancelled, false);
});
test('delivery identity is checked again under the writer lock', async () => {
  const receiver = Object.create(Receiver.prototype);
  receiver.store = { locked: (fn) => fn(), save: async () => assert.fail('must not save') };
  receiver.read = async () => ({
    activeId: 'b'.repeat(24),
    deliveries: [{ id: 'b'.repeat(24), status: 'PR_REQUIRED' }],
  });
  let changed = false;
  await assert.rejects(
    () =>
      runExecution({ deliveryId: 'a'.repeat(24), signal: new AbortController().signal, report: () => {} }, () =>
        receiver.change(async () => {
          changed = true;
        }),
      ),
    { code: 'DELIVERY_CHANGED' },
  );
  assert.equal(changed, false);
});
test('a stale start page cannot start a different queued target', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await assert.rejects(() => receiver.start('0'.repeat(40)), { code: 'QUEUE_CHANGED' });
  assert.equal((await receiver.status()).active, undefined);
  assert.equal((await receiver.status()).queue[0].target, f.u1);
});
