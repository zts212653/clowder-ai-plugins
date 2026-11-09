import assert from 'node:assert/strict';
import test from 'node:test';
import { isPluginDeliveryInput } from '@clowder-ai/plugin-contract';
import { inboxSchema, queued, read } from '../src/state.js';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

for (const phase of ['pending', 'routed', 'failed', 'done']) {
  test(`retained pre-reason ${phase} inbox remains readable after the contract upgrade`, async () => {
    const f = fixture();
    const legacy = event('legacy');
    delete (legacy as { reason?: string }).reason;
    assert.equal(isPluginDeliveryInput(legacy), false, 'live ingress still requires a reason');
    await f.host.storage.set('inbox:legacy', { delivery: legacy, phase, attempt: 2, receivedAt: 1 });
    await f.host.storage.set('queue', { inbox: ['legacy'] });
    const restored = await queued(f.host, 'inbox', 'inbox:', inboxSchema);
    assert.equal(restored[0]?.delivery.reason, 'subscription');
    assert.equal(restored[0]?.phase, phase);
    assert.equal(restored[0]?.attempt, 2);
    assert.equal((await read(f.host, 'inbox:legacy', inboxSchema))?.delivery.reason, 'subscription');
    assert.equal(
      inboxSchema.safeParse({ delivery: { ...legacy, reason: 'invalid' }, phase, receivedAt: 1 }).success,
      false,
    );
  });
}

test('legacy failed inbox supports inspection, explicit owner retry and routing after restart', async () => {
  const f = fixture();
  await f.seed();
  const legacy = event('legacy-failed');
  delete (legacy as { reason?: string }).reason;
  await f.host.storage.set('inbox:legacy-failed', { delivery: legacy, phase: 'failed', receivedAt: 1 });
  await f.host.storage.set('queue', { inbox: ['legacy-failed'] });
  const runtime = await startSuperagent(f.host);
  try {
    const main = (f.rows.get('runtime')!.value as { mainThreadId: string }).mainThreadId;
    const inspect = (await runtime.actions['superagent.inspect']({}, f.caller(main))) as {
      inbox: { delivery: { reason: string } }[];
    };
    assert.equal(inspect.inbox[0].delivery.reason, 'subscription');
    await assert.rejects(async () => runtime.actions['superagent.observe'](legacy), /Invalid Superagent delivery/);
    await runtime.actions['superagent.retry']({}, undefined, {
      kind: 'owner-operation',
      userId: 'owner',
      pluginInstanceId: f.host.pluginInstanceId,
      operationKey: 'activity',
      actionId: 'retry',
      requestId: 'retry-legacy',
      confirmed: true,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    });
    await runtime.actions['superagent.tick']({});
    const stored = await read(f.host, 'inbox:legacy-failed', inboxSchema);
    assert.equal(stored?.delivery.reason, 'subscription');
    assert.equal(stored?.phase, 'routed');
    assert.equal(stored?.attempt, 1);
  } finally {
    await runtime.stop({ reason: 'test' });
  }
});
