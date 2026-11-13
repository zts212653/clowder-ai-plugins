import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

test('one observed request can create two canonical Work items; cross-thread feedback keeps the original Work and execution thread', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const call = runtime.actions;
  await call['superagent.observe'](event('outside', 'outside'));
  await call['superagent.tick']({});
  assert.equal(f.sent.size, 0, 'unselected conversation cannot wake a member');
  await call['superagent.observe'](event('new-work'));
  await call['superagent.observe'](event('new-work'));
  await call['superagent.tick']({});
  const coordinatorWake = [...f.sent.values()].filter((m) => m.wake);
  assert.equal(coordinatorWake.length, 1, 'one durable event produces one coordinator input');
  const main = coordinatorWake[0].threadId;
  await call['superagent.route'](
    {
      eventId: 'new-work',
      decisions: [
        {
          kind: 'start',
          title: '导出修复',
          outcome: '修复并验证导出',
          workerId: 'worker',
        },
        {
          kind: 'start',
          title: '发布说明',
          outcome: '准备可审阅的发布说明',
          workerId: 'worker',
        },
      ],
    },
    f.caller(main),
  );
  await call['superagent.tick']({});
  assert.equal(f.tasks.size, 2);
  const original = [...f.tasks.values()][0];
  assert.notEqual(original.threadId, main, 'a long work turn does not occupy the Bot conversation');
  assert.ok([...f.sent.values()].some((m) => m.threadId === original.threadId && m.wake));
  await call['superagent.observe'](event('feedback', 'source-b', '刚才的导出修复还漏了空文件。'));
  await call['superagent.tick']({});
  await call['superagent.route'](
    {
      eventId: 'feedback',
      decisions: [
        {
          kind: 'follow_up',
          workId: original.id,
          content: '补上空文件场景并验证。',
        },
      ],
    },
    f.caller(main),
  );
  await call['superagent.tick']({});
  assert.equal(f.tasks.size, 2, 'feedback must not become a third Work');
  assert.ok(
    [...f.sent.values()].some((m) => m.threadId === original.threadId && JSON.stringify(m.payload).includes('空文件')),
  );
  const count = f.sent.size;
  await call['superagent.tick']({});
  assert.equal(f.sent.size, count, 'idle ticks do not call a model or repeat deliveries');
  await runtime.stop({ reason: 'test' });
});

test('pause and a normal restart preserve the Bot conversation and pending input without duplicate work', async () => {
  const f = fixture();
  await f.seed();
  const first = await startSuperagent(f.host);
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  await first.configRefresh?.();
  await first.actions['superagent.observe'](event('during-pause'));
  await first.actions['superagent.tick']({});
  assert.equal(f.sent.size, 0);
  const count = f.threads.size;
  await first.stop({ reason: 'shutdown' });
  await f.host.storage.set('preferences', f.preferences);
  const second = await startSuperagent(f.host);
  await second.actions['superagent.tick']({});
  assert.equal(f.threads.size, count, 'restart returns to the same durable Bot conversation');
  assert.equal([...f.sent.values()].filter((m) => m.wake).length, 1);
  await second.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((m) => m.wake).length, 1);
  await assert.rejects(async () => first.actions['superagent.tick']({}), /stopped/);
  await second.stop({ reason: 'test' });
});

test('a model call from another thread cannot route work; background and undecided ideas do not create work', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('idea', 'source-a', '也许以后可以加一个新主题，先聊聊。'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((m) => m.wake);
  assert.ok(wake, 'a selected idea still reaches semantic judgment');
  const main = wake.threadId;
  await assert.rejects(
    Promise.resolve().then(() =>
      runtime.actions['superagent.route'](
        {
          eventId: 'idea',
          decisions: [{ kind: 'ignore', reason: '尚未委托的想法' }],
        },
        f.caller('outside'),
      ),
    ),
    /coordinator/,
  );
  await runtime.actions['superagent.route'](
    {
      eventId: 'idea',
      decisions: [{ kind: 'ignore', reason: '尚未委托的想法' }],
    },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('a lost worker wake receipt retries its original input and preserves the original canonical Work', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('retry'));
  await runtime.actions['superagent.tick']({});
  const main = [...f.sent.values()].find((m) => m.wake)!.threadId;
  await runtime.actions['superagent.route'](
    {
      eventId: 'retry',
      decisions: [
        {
          kind: 'start',
          title: '导出修复',
          outcome: '修复导出',
          workerId: 'worker',
        },
      ],
    },
    f.caller(main),
  );
  const send = f.host.messaging.send;
  let loseReceipt = true;
  f.host.messaging.send = async (input) => {
    const result = await send(input);
    if (input.wake && input.threadId !== main && loseReceipt) {
      loseReceipt = false;
      throw new Error('lost-worker-ack');
    }
    return result;
  };
  await assert.rejects(async () => runtime.actions['superagent.tick']({}), /lost-worker-ack/);
  const original = [...f.tasks.values()][0];
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.size, 1);
  assert.equal([...f.tasks.values()][0].id, original.id);
  assert.equal([...f.sent.values()].filter((m) => m.threadId === original.threadId && m.wake).length, 1);
  await runtime.stop({ reason: 'test' });
});

test('worker questions and results return in place; a result stays open until its human owner accepts', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('delivery'));
  await runtime.actions['superagent.tick']({});
  const main = [...f.sent.values()].find((m) => m.wake)!.threadId;
  await runtime.actions['superagent.route'](
    {
      eventId: 'delivery',
      decisions: [
        {
          kind: 'start',
          title: '导出修复',
          outcome: '修复导出',
          workerId: 'worker',
        },
      ],
    },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  const task = [...f.tasks.values()][0];
  const caller = f.caller(task.threadId, 'worker');
  const report = {
    workId: task.id,
    reportId: 'result',
    kind: 'result',
    content: '已修复空文件导出，附验证结果。',
  };
  await runtime.actions['superagent.report'](report, caller);
  await runtime.actions['superagent.tick']({});
  await runtime.actions['superagent.report'](report, caller);
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.get(task.id)?.entrustedWork?.closure.state, 'open');
  const delivered = [...f.sent.values()].filter(
    (m) => m.threadId === 'source-a' && JSON.stringify(m.payload).includes('已修复空文件'),
  );
  assert.equal(delivered.length, 1);
  const acceptance = event('accepted', 'source-b', '导出结果验收通过。');
  await runtime.actions['superagent.observe'](acceptance);
  await runtime.actions['superagent.tick']({});
  await runtime.actions['superagent.route'](
    { eventId: 'accepted', decisions: [{ kind: 'accept', workId: task.id }] },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.get(task.id)?.entrustedWork?.closure.state, 'satisfied');
  const view = JSON.parse(((await runtime.actions['superagent.view']({})) as { body: string }).body);
  assert.ok(view && typeof view === 'object' && 'badgeCount' in view);
  assert.equal(view.badgeCount, 0);
  await runtime.stop({ reason: 'test' });
});

test('enable reads the coordinator, workers and conversations from the plugin configuration', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  f.config.set('responsibility', f.preferences.responsibility);
  f.config.delete('threadIds');
  const runtime = await startSuperagent(f.host);
  const owner = {
    kind: 'owner-operation' as const,
    userId: 'owner',
    pluginInstanceId: f.host.pluginInstanceId,
    operationKey: 'activity',
    actionId: 'enable',
    requestId: 'request-enable',
    confirmed: true,
    signal: new AbortController().signal,
    assertCurrent: async () => {},
  };
  await assert.rejects(async () => runtime.actions['superagent.enable']({}, undefined, owner), /监听会话/);
  f.config.set('threadIds', '["source-a"]');
  await runtime.actions['superagent.enable']({}, undefined, owner);
  assert.equal(f.subscriptions.has('source-a'), true);
  assert.equal(f.subscriptions.has('source-b'), false);
  await runtime.stop({ reason: 'test' });
});
