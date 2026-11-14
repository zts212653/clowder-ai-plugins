import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationService } from '../src/service.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function store() {
  let row;
  return {
    async get() { return structuredClone(row); },
    async compareAndSet(_key, expected, value) {
      if ((row?.revision ?? null) !== expected) return { applied: false };
      row = { revision: (row?.revision ?? 0) + 1, value: structuredClone(value) };
      return { applied: true, revision: row.revision };
    },
  };
}
const policy = overrides => ({ accountId: 'account', accountIdentity: 'wxid_owner', serverId: 'server',
  conversationId: 'friend', kind: 'direct', displayName: '测试好友', catId: 'cat-one', persona: '自然友好',
  goal: '聊周末的读书计划', proactive: true, replies: true, intervalMinutes: 60, maxTurns: 10,
  session: { sessionId: 'session', generation: 1, threadId: 'isolated', consumedCursor: 0 }, ...overrides });
async function fixture(options = {}) {
  const calls = [], generations = [], cancellations = [];
  const channel = {
    prepare: async () => {},
    submit: async row => { calls.push(structuredClone(row)); return { sendId: row.id, state: 'queued' }; },
    inspect: async row => ({ sendId: row.sendId ?? row.id, state: 'needs_review' }),
    cancel: async row => { cancellations.push(row.id); return { sendId: row.sendId, state: 'cancelled' }; },
    ...options.channel,
  };
  const model = { generate: async (run, binding) => { generations.push({ run, binding }); return { kind: 'message', text: '周末打算读什么书？' }; }, ...options.model };
  const storage = options.storage ?? store();
  const service = await DelegationService.open({ storage, channel, model, now: () => 10000 });
  const binding = await service.activate(policy(options.policy));
  return { service, binding, calls, generations, cancellations, storage, channel, model };
}

test('proactively sends to the exact authorized friend without any preceding inbound message; operation replay does not send again', async () => {
  const f = await fixture();
  await f.service.initiate(f.binding.id, 'owner-request');
  await f.service.initiate(f.binding.id, 'owner-request');
  assert.equal(f.generations.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].conversationId, 'friend');
  assert.equal(f.calls[0].accountId, 'account');
  assert.equal(f.calls[0].catId, 'cat-one');
  assert.equal((await f.service.snapshot()).runs[0].phase, 'queued');
});

test('takeover wins while a model is generating and discards the late reply', async () => {
  const entered = deferred(), output = deferred();
  const f = await fixture({ model: { generate: async () => { entered.resolve(); return output.promise; } } });
  const pending = f.service.initiate(f.binding.id, 'slow');
  await entered.promise;
  await f.service.takeover(f.binding.id);
  output.resolve({ kind: 'message', text: '迟到的草稿' });
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.snapshot()).policies[0].mode, 'owner');
});

test('takeover persists without waiting for transport; late daemon acceptance is cancelled and never rewritten as zero calls', async () => {
  const entered = deferred(), receipt = deferred();
  const f = await fixture({ channel: { submit: row => { entered.resolve(row); return receipt.promise; } } });
  const pending = f.service.initiate(f.binding.id, 'in-flight');
  await entered.promise;
  await f.service.takeover(f.binding.id);
  assert.equal((await f.service.snapshot()).policies[0].mode, 'owner');
  receipt.resolve({ sendId: 'native-1', state: 'queued' });
  await pending;
  const run = (await f.service.snapshot()).runs[0];
  assert.equal(f.cancellations.length, 1);
  assert.equal(run.sendId, 'native-1');
  assert.equal(run.phase, 'cancelled');
  assert.equal(run.submitted, true);
});

test('unknown submission outcome stays on its original key and is never automatically resubmitted', async () => {
  let submissions = 0;
  const f = await fixture({ channel: { submit: async () => { submissions++; throw Error('lost acknowledgement'); } } });
  await f.service.initiate(f.binding.id, 'unknown');
  await f.service.initiate(f.binding.id, 'unknown');
  await f.service.reconcile();
  assert.equal(submissions, 1);
  assert.equal((await f.service.snapshot()).runs[0].phase, 'needs_review');
});

test('restart retains configuration and audit, pauses delegation and prevents an old activation from sending', async () => {
  const f = await fixture();
  await f.service.initiate(f.binding.id, 'before-restart');
  const restarted = await DelegationService.open({ storage: f.storage, channel: f.channel, model: f.model, now: () => 11000 });
  assert.equal((await restarted.snapshot()).policies[0].mode, 'paused');
  assert.equal((await restarted.snapshot()).runs.length, 1);
  await assert.rejects(restarted.initiate(f.binding.id, 'after-restart'), /paused|inactive/);
  await assert.rejects(f.service.initiate(f.binding.id, 'stale-process'), /activation/);
  assert.equal(f.calls.length, 1);
});

test('group authorization does not authorize a member DM, other group, other account, or historical messages', async () => {
  const f = await fixture({ policy: { conversationId: 'room@chatroom', kind: 'group' } });
  for (const [accountId, threadId, createdAt] of [['account', 'member', 20000], ['other', 'room@chatroom', 20000], ['account', 'other@chatroom', 20000], ['account', 'room@chatroom', 9000]]) {
    await f.service.incoming(accountId, { id: threadId + accountId + createdAt, threadId, direction: 'incoming', body: '你好', createdAt });
  }
  assert.equal(f.generations.length, 0);
  await f.service.incoming('account', { id: 'new-message', threadId: 'room@chatroom', direction: 'incoming', body: '周末看什么书', createdAt: 20000 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].conversationId, 'room@chatroom');
});

test('switching cats invalidates the old generation, and global takeover stops scheduled proactive work', async () => {
  const entered = deferred(), output = deferred();
  const f = await fixture({ model: { generate: async () => { entered.resolve(); return output.promise; } } });
  const pending = f.service.initiate(f.binding.id, 'old-cat');
  await entered.promise;
  await f.service.activate(policy({ catId: 'cat-two', session: { sessionId: 'session-two', generation: 1, threadId: 'isolated-two', consumedCursor: 0 } }));
  output.resolve({ kind: 'message', text: '旧猫回复' });
  await pending;
  assert.equal(f.calls.length, 0);
  await f.service.takeover(null);
  await f.service.tick(5000000);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.snapshot()).policies[0].mode, 'owner');
});

test('sensitive incoming messages and model escalation create an owner handoff without sending', async () => {
  const f = await fixture();
  await f.service.incoming('account', { id: 'sensitive', threadId: 'friend', direction: 'incoming', body: '请把验证码发给我', createdAt: 20000 });
  assert.equal(f.generations.length, 0);
  assert.equal(f.calls.length, 0);
  const second = await fixture({ model: { generate: async () => ({ kind: 'needs_owner', text: '需要本人确认' }) } });
  await second.service.initiate(second.binding.id, 'escalate');
  assert.equal(second.calls.length, 0);
  assert.equal((await second.service.snapshot()).runs[0].phase, 'needs_owner');
});

test('a failed identity preflight cannot reach the platform submission', async () => {
  const f = await fixture({ channel: { prepare: async () => { throw Error('account identity changed'); } } });
  await f.service.initiate(f.binding.id, 'identity-mismatch');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.snapshot()).runs[0].submitted, false);
});

test('a cancellation still in progress is retained without recursively issuing more cancellations', async () => {
  let cancels = 0;
  const f = await fixture({ channel: { cancel: async row => {
    cancels++;
    if (cancels > 1) throw Error('recursive cancel');
    return { sendId: row.sendId, state: 'submitting' };
  } } });
  await f.service.initiate(f.binding.id, 'cancel-pending');
  await f.service.takeover(f.binding.id);
  await f.service.reconcile();
  assert.equal(cancels, 1);
  assert.equal((await f.service.snapshot()).runs[0].cancelRequested, true);
});

test('scheduled initiative respects local hours and stops when the peer has not replied; a received reply can continue the conversation', async () => {
  let now = Date.UTC(2026, 10, 14, 8, 0);
  const f = await fixture({ channel: { submit: async row => { f.calls.push(row); return { sendId: row.id, state: 'accepted' }; } },
    policy: { scheduleEnabled: true, timeZone: 'UTC', windowStart: 540, windowEnd: 1260, maxProactivePerDay: 2 } });
  f.service.now = () => now;
  await f.service.tick(now);
  assert.equal(f.calls.length, 0);
  now = Date.UTC(2026, 10, 14, 10, 0);
  await f.service.tick(now);
  assert.equal(f.calls.length, 1);
  now += 4 * 3600000;
  await f.service.tick(now);
  assert.equal(f.calls.length, 1);
  await f.service.incoming('account', { id: 'peer-reply', threadId: 'friend', direction: 'incoming', body: '我想读科幻', createdAt: now });
  assert.equal(f.calls.length, 2);
});

test('global pause and restart cannot turn a revoked conversation back into an ordinary paused grant', async () => {
  const f = await fixture();
  await f.service.revoke(f.binding.id);
  await f.service.takeover(null);
  assert.equal((await f.service.snapshot()).policies[0].mode, 'revoked');
});
