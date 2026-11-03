import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

test('a coordinator delivery is visible as pending acceptance until its owner accepts', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('start'));
  await runtime.actions['superagent.tick']({});
  const main = [...f.sent.values()].find((message) => message.wake)!.threadId;
  await runtime.actions['superagent.route'](
    { eventId: 'start', decisions: [{ kind: 'start', title: '样例', outcome: '验证样例', workerId: 'worker' }] },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  const work = [...f.tasks.values()][0];
  await runtime.actions['superagent.observe'](event('delivery', work.threadId, '样例已验证，等待用户接受。'));
  await runtime.actions['superagent.route'](
    { eventId: 'delivery', decisions: [{ kind: 'deliver', workId: work.id, content: '样例已验证，等待用户接受。' }] },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  assert.equal(((await runtime.actions['superagent.view']({})) as { badgeCount: number }).badgeCount, 1);
  assert.equal(f.tasks.get(work.id)?.entrustedWork?.closure.state, 'open');
  await runtime.actions['superagent.observe'](event('accepted', 'source-b', '这个结果验收通过。'));
  await runtime.actions['superagent.route'](
    { eventId: 'accepted', decisions: [{ kind: 'accept', workId: work.id }] },
    f.caller(main),
  );
  await runtime.actions['superagent.tick']({});
  assert.equal(((await runtime.actions['superagent.view']({})) as { badgeCount: number }).badgeCount, 0);
  assert.equal(f.tasks.get(work.id)?.entrustedWork?.closure.state, 'satisfied');
  await runtime.stop({ reason: 'test' });
});
