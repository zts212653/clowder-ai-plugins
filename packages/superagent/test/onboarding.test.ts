import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { inboxSchema, runtimeSchema } from '../src/state.js';
import { event, fixture } from './fixture.js';

test('a configured main conversation contains one introduction across idle ticks and restarts, without waking a model', async () => {
  const f = fixture();
  await f.seed();
  const first = await startSuperagent(f.host);
  const introductions = [...f.sent.values()];
  assert.equal(introductions.length, 1, 'opening a configured assistant must not leave a blank conversation');
  assert.equal(introductions[0].wake, undefined, 'a readiness message must not incur a model call');
  assert.match(JSON.stringify(introductions[0].payload), /我的助手|助手会话/);
  await first.configRefresh?.();
  await first.actions['superagent.tick']({});
  await first.stop({ reason: 'restart' });
  const second = await startSuperagent(f.host);
  assert.equal(f.sent.size, 1, 'the durable idempotency key survives a normal restart');
  assert.equal(f.tasks.size, 0);
  await second.stop({ reason: 'test' });
});

test('the first coordinator wake supplies the plugin tool entry and exact event coordinates before inspect', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('first-request'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((message) => message.wake)!;
  const text = JSON.stringify(wake.payload);
  assert.ok(text.length < 600, 'visible wake must bootstrap tools without pasting the full coordinator manual');
  for (const required of [
    'official.superagent',
    'plugin_list_tools',
    'plugin_call',
    'superagent_inspect',
    'superagent_route',
    'first-request',
    'source-a',
    'source-first-request',
  ]) {
    assert.ok(text.includes(required), `the wake must bootstrap ${required} without a global work scan`);
  }
  const inspected = (await runtime.actions['superagent.inspect']({}, f.caller(wake.threadId))) as {
    inbox: { delivery: { deliveryId: string } }[];
  };
  assert.equal(inspected.inbox[0].delivery.deliveryId, 'first-request');
  await runtime.actions['superagent.route'](
    { eventId: 'first-request', decisions: [{ kind: 'ignore', reason: '原事项已有成员处理' }] },
    f.caller(wake.threadId),
  );
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('an existing paused or failed assistant introduction describes its actual state without paid recovery', async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    await f.host.storage.set('preferences', { ...f.preferences, enabled: false, started: true });
    if (failed) await f.host.storage.set('runtime', { error: 'previous coordinator finished without routing' });
    const runtime = await startSuperagent(f.host);
    const introduction = [...f.sent.values()][0];
    assert.match(JSON.stringify(introduction.payload), failed ? /上轮跟进未完成|重试/ : /暂停/);
    assert.equal(introduction.wake, undefined);
    assert.equal(f.tasks.size, 0);
    await runtime.stop({ reason: 'test' });
  }
});

test('a completed coordinator without a judgment reports the failure in its main conversation once and retains the event', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('unhandled'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((message) => message.wake)!;
  f.history.set(wake.threadId, [
    {
      id: 'finished',
      timestamp: 2,
      content: '没有待办',
      sender: { kind: 'cat', catId: 'coordinator' },
      response: {
        executionId: 'finished-without-route',
        inputMessageIds: [wake.messageId],
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
      },
    },
  ]);
  await assert.rejects(async () => runtime.actions['superagent.tick']({}), /判断/);
  const notices = [...f.sent.values()].filter(
    (message) => !message.wake && JSON.stringify(message.payload).includes('重试'),
  );
  assert.equal(notices.length, 1, 'the owner must see why automatic follow-up stopped');
  assert.equal(notices[0].threadId, runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId);
  assert.notEqual(notices[0].threadId, wake.threadId, 'actionable failure belongs in the inbox, not the internal coordination thread');
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 1, 'no automatic paid retry');
  assert.equal(inboxSchema.parse(f.rows.get('inbox:unhandled')?.value).phase, 'failed');
  await runtime.stop({ reason: 'test' });
});
