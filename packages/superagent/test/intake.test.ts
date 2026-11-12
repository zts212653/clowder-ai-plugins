import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

test('direct Bot conversations use the configured coordinator, including a change of coordinator', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const main = [...f.threads.values()].find((thread) => thread.title === f.preferences.name)!;
  assert.deepEqual(main.preferredCats, ['coordinator']);
  f.config.set('coordinatorId', 'other');
  await runtime.configRefresh?.();
  assert.deepEqual(f.threads.get(main.id)?.preferredCats, ['other']);
  await runtime.stop({ reason: 'test' });
});

test('the coordinator own reply in the Bot conversation does not become another intake event', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const main = [...f.threads.values()].find((thread) => thread.title === f.preferences.name)!;
  const reply = event('coordinator-reply', main.id, '已接住这两件事。');
  reply.envelope.actor = { kind: 'cat', id: 'coordinator' };
  await runtime.actions['superagent.observe'](reply);
  await runtime.actions['superagent.tick']({});
  const snapshot = (await runtime.actions['superagent.inspect']({}, f.caller(main.id))) as { inbox: unknown[] };
  assert.equal(snapshot.inbox.length, 0);
  await runtime.stop({ reason: 'test' });
});

test('an unclear request asks in place before creating Work; an answer resolves the pending question', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const actions = runtime.actions;
  await actions['superagent.observe'](event('unclear', 'source-a', '把上次那个也处理一下。'));
  await actions['superagent.tick']({});
  const main = [...f.sent.values()].find((message) => message.wake)!.threadId;
  await actions['superagent.route'](
    {
      eventId: 'unclear',
      decisions: [{ kind: 'ask', content: '指的是哪一项？' }],
    },
    f.caller(main),
  );
  await actions['superagent.tick']({});
  assert.equal(f.tasks.size, 0, 'clarification must not invent a Work');
  assert.ok(
    [...f.sent.values()].some(
      (message) => message.threadId === 'source-a' && JSON.stringify(message.payload).includes('哪一项'),
    ),
  );
  const inspected = (await actions['superagent.inspect']({}, f.caller(main))) as { questions: { id: string }[] };
  assert.equal(inspected.questions.length, 1);
  await actions['superagent.observe'](event('answer', 'source-b', '是导出修复，请补上空文件处理。'));
  await actions['superagent.tick']({});
  await actions['superagent.route'](
    {
      eventId: 'answer',
      decisions: [
        {
          kind: 'start',
          title: '导出修复',
          outcome: '空文件也能导出',
          workerId: 'worker',
          questionId: inspected.questions[0].id,
        },
      ],
    },
    f.caller(main),
  );
  await actions['superagent.tick']({});
  assert.equal(f.tasks.size, 1);
  const view = JSON.parse(((await actions['superagent.view']({})) as { body: string }).body) as { badgeCount: number };
  assert.equal(view.badgeCount, 0);
  await runtime.stop({ reason: 'test' });
});
