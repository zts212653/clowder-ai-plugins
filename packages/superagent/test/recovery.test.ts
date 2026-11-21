import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

test('a coordinator that finishes without a decision becomes visibly failed; only explicit retry wakes it again', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('failure'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((message) => message.wake)!;
  f.history.set(wake.threadId, [
    {
      id: 'response',
      timestamp: 2,
      content: '未调用工具',
      sender: { kind: 'cat', catId: 'coordinator' },
      response: {
        executionId: 'opaque-execution',
        inputMessageIds: [wake.messageId],
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
      },
    },
  ]);
  await assert.rejects(async () => runtime.actions['superagent.tick']({}), /判断/);
  await runtime.actions['superagent.tick']({});
  const view = JSON.parse(((await runtime.actions['superagent.view']({})) as { body: string }).body) as {
    status: string;
    detail: string;
  };
  assert.equal(view.status, 'error');
  assert.match(view.detail, /判断|decision/);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 1, 'no automatic paid retry');
  const owner = {
    kind: 'owner-operation' as const,
    userId: 'owner',
    pluginInstanceId: f.host.pluginInstanceId,
    operationKey: 'activity',
    actionId: 'retry',
    requestId: 'request-retry',
    signal: new AbortController().signal,
    confirmed: true,
    assertCurrent: async () => {},
  };
  await runtime.actions['superagent.retry']({}, undefined, owner);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 2);
  assert.equal((JSON.parse(((await runtime.actions['superagent.view']({})) as { body: string }).body) as { status: string }).status, 'listening');
  await runtime.stop({ reason: 'test' });
});

test('a worker native result and its ordinary final response produce one original delivery', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const actions = runtime.actions;
  await actions['superagent.observe'](event('work'));
  await actions['superagent.tick']({});
  const main = [...f.sent.values()].find((message) => message.wake)!.threadId;
  await actions['superagent.route'](
    {
      eventId: 'work',
      decisions: [
        {
          kind: 'start',
          title: '导出',
          outcome: '验证导出',
          workerId: 'worker',
        },
      ],
    },
    f.caller(main),
  );
  await actions['superagent.tick']({});
  const task = [...f.tasks.values()][0];
  await actions['superagent.report'](
    { workId: task.id, reportId: 'done', kind: 'result', content: '已验证' },
    f.caller(task.threadId, 'worker'),
  );
  await actions['superagent.tick']({});
  const final = event('final-response', task.threadId, '已验证');
  final.envelope.actor = { kind: 'cat', id: 'worker' };
  f.messages.set(final.envelope.messageId, {
    id: final.envelope.messageId,
    threadId: task.threadId,
    userId: 'owner',
    catId: 'worker',
    content: '已验证',
    mentions: [],
    timestamp: 2,
    sourceRevision: '1',
    extra: {
      stream: { invocationId: f.caller(task.threadId, 'worker').invocationId },
    },
  });
  const count = [...f.sent.values()].filter((message) => message.wake).length;
  await actions['superagent.observe'](final);
  await actions['superagent.tick']({});
  assert.equal(
    [...f.sent.values()].filter((message) => message.wake).length,
    count,
    'only a positively correlated native terminal report suppresses its echo',
  );
  await runtime.stop({ reason: 'test' });
});

test('a real Host failed message is returned once to its own Work while intake is paused, regardless of lifecycle hash', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const actions = runtime.actions;
  await actions['superagent.observe'](event('work'));
  await actions['superagent.tick']({});
  const main = [...f.sent.values()].find((message) => message.wake)!.threadId;
  await actions['superagent.route'](
    {
      eventId: 'work',
      decisions: [
        {
          kind: 'start',
          title: '导出',
          outcome: '验证导出',
          workerId: 'worker',
        },
        { kind: 'start', title: '说明', outcome: '准备说明', workerId: 'worker' },
      ],
    },
    f.caller(main),
  );
  await actions['superagent.tick']({});
  const task = [...f.tasks.values()][0];
  const other = [...f.tasks.values()][1];
  await f.host.storage.set('preferences', {
    ...f.preferences,
    enabled: false,
    started: true,
  });
  f.history.set(task.threadId, [
    {
      id: 'failed-response',
      timestamp: 2,
      content: '',
      sender: { kind: 'cat', catId: 'worker' },
      response: {
        executionId: '01a1a2a5-dbe0-7f30-9066-3291e6f7ff3f',
        inputMessageIds: ['worker-input'],
        status: 'failed',
        startedAt: 1,
        completedAt: 2,
      },
    },
  ]);
  const status = {
    kind: 'execution_status',
    deliveryId: 'failure-status',
    threadId: task.threadId,
    state: 'settled',
    chainDone: true,
    outcome: 'failed',
    executionId: `lifecycle_${createHash('sha256').update('01a1a2a5-dbe0-7f30-9066-3291e6f7ff3f').digest('hex').slice(0, 32)}`,
  };
  const wrong = event('not-a-response', other.threadId, '');
  wrong.envelope.actor = { kind: 'cat', id: 'worker' };
  wrong.envelope.messageId = 'failed-response';
  await actions['superagent.observe'](wrong);
  await actions['superagent.observe'](status);
  const failed = event('failed-response', task.threadId, '');
  failed.envelope.actor = { kind: 'cat', id: 'worker' };
  failed.envelope.messageId = 'failed-response';
  await actions['superagent.observe']({ ...failed, executionId: status.executionId });
  await actions['superagent.observe']({ ...failed, executionId: status.executionId });
  await actions['superagent.observe'](status);
  await actions['superagent.observe'](status);
  await actions['superagent.tick']({});
  assert.equal(f.tasks.get(task.id)?.status, 'blocked');
  assert.equal(f.tasks.get(other.id)?.status, 'todo', 'a failure must not be assigned to another Work');
  assert.equal(
    [...f.sent.values()].filter(
      (message) => message.threadId === 'source-a' && JSON.stringify(message.payload).includes('本轮未完成'),
    ).length,
    1,
  );
  await runtime.stop({ reason: 'test' });
});
