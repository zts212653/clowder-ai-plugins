import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxSchema, queued } from '../src/state.js';
import { event, fixture } from './fixture.js';

test('a retained 72-event inbox stays within the execution RPC request capacity and preserves order', async () => {
  const f = fixture();
  const ids = Array.from({ length: 72 }, (_, index) => `backlog-${index}`);
  await f.host.storage.set('queue', { inbox: ids });
  await Promise.all(ids.map((id) => f.host.storage.set(`inbox:${id}`, { delivery: event(id), phase: 'pending', receivedAt: 1 })));
  const get = f.host.storage.get;
  let active = 0;
  let peak = 0;
  f.host.storage.get = async (key) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    if (peak > 64) throw new Error('Execution request capacity is busy');
    return get(key);
  };
  const entries = await queued(f.host, 'inbox', 'inbox:', inboxSchema);
  assert.deepEqual(entries.map((entry) => entry.delivery.deliveryId), ids);
  assert.ok(peak <= 64);
});
