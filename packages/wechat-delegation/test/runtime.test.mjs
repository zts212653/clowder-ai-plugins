import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationRuntime } from '../src/runtime.mjs';

export function memoryStorage() {
  const data = new Map();
  return { get: async key => structuredClone(data.get(key)),
    compareAndSet: async (key, expected, value) => { const old = data.get(key); if ((old?.revision ?? null) !== expected) return { applied: false };
      const row = { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }; data.set(key, row); return { applied: true, revision: row.revision }; } };
}
export const owner = overrides => ({ kind: 'owner-http-request', userId: 'owner', pluginInstanceId: 'plugin', operation: 'write',
  requestIdentity: { requestId: 'request' }, signal: new AbortController().signal, assertCurrent: async () => {}, ...overrides });
async function fixture(t) {
  const sends = [], logins = []; let prepared = 0;
  const client = {
    json: async () => ({ items: [{ id: 'clowder' }] }),
    identity: async () => ({ serverId: 'server', accountId: 'clowder', accountIdentity: 'wxid_owner', connected: true }),
    account: async () => ({ id: 'clowder', authenticated: true, ownUsername: 'wxid_owner', connection: 'online' }),
    createAccount: async () => ({}),
    threads: async () => ({ items: [{ id: 'room@chatroom', accountId: 'clowder', kind: 'group', displayName: '测试群' }], nextCursor: null }),
    login: async (_id, key) => { logins.push(key); return { id: 'login', kind: 'login', accountId: 'clowder', state: 'awaiting_scan' }; },
    operation: async () => ({ id: 'login', kind: 'login', accountId: 'clowder', state: 'awaiting_scan', result: { qrAvailable: true } }),
    qr: async () => 'data:image/png;base64,aGVsbG8=', prepare: async () => {},
    submit: async run => { sends.push(run); return { sendId: 'send', state: 'queued' }; },
    inspect: async () => ({ sendId: 'send', state: 'cancelled' }), cancel: async () => ({ sendId: 'send', state: 'cancelled' }),
  };
  const host = { pluginInstanceId: 'plugin', dataPath: '/unused', storage: memoryStorage(),
    members: { list: async () => [{ catId: 'cat', displayName: '测试猫', available: true }] },
    threads: { get: async id => ({ id }), list: async () => [] },
    messaging: { get: async () => null, subscribe: async () => {}, unsubscribe: async () => {} },
  };
  const model = { available: () => true, describe: async () => ({ available: true, fingerprint: 'preview', runtime: { clientId: 'test', model: 'test' } }),
    prepare: async () => ({ sessionId: 's', generation: 1, threadId: 'isolated', consumedCursor: 0 }),
    generate: async () => ({ kind: 'message', text: '今晚有人一起读书吗？' }) };
  const supervisor = { client: null, prepare: async () => { prepared++; supervisor.client = client; return client; }, stop: async () => { supervisor.client = null; } };
  const runtime = await DelegationRuntime.open(host, { supervisor, model, startTimer: false });
  t.after(() => runtime.stop());
  return { runtime, sends, logins, host, client, prepared: () => prepared };
}
test('activation is dormant and actions reject forged or stale owner contexts', async t => {
  const f = await fixture(t);
  assert.equal(f.prepared(), 0);
  for (const context of [undefined, owner({ pluginInstanceId: 'foreign' }), owner({ operation: 'read' })])
    await assert.rejects(f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, context), /owner|本人|已登录/);
  assert.equal(f.prepared(), 0);
});
test('owner login retries stay on the original durable operation and never grant conversation access', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'login' }, owner());
  await f.runtime.dispatch({ action: 'login' }, owner());
  assert.equal(f.logins.length, 1);
  assert.equal((await f.runtime.status()).policies.length, 0);
  assert.equal(f.sends.length, 0);
});
test('owner selects a real group and cat, enables delegation, proactively sends then takes over through plugin operations', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然友好',
    goal: '今晚一起读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  const binding = (await f.runtime.status()).policies[0];
  await f.runtime.dispatch({ action: 'initiate', policyId: binding.id, operationId: 'explicit-owner-action' }, owner());
  await f.runtime.drain();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].conversationId, 'room@chatroom');
  await f.runtime.dispatch({ action: 'takeover', policyId: binding.id }, owner());
  assert.equal((await f.runtime.status()).policies[0].mode, 'owner');
  await assert.rejects(f.runtime.dispatch({ action: 'initiate', policyId: binding.id, operationId: 'after-takeover' }, owner()), /paused|inactive/);
});

test('a changed model preview cannot silently grant a different model service', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await assert.rejects(f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'stale-preview' }, owner()), /模型|model/);
  assert.equal((await f.runtime.status()).policies.length, 0);
});

test('only a canonical human owner stop in the selected Clowder thread can interrupt delegation; redelivery is idempotent', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true,
    modelFingerprint: 'preview', notificationThreadId: 'trusted-thread' }, owner());
  let source = { id: 'stop-message', threadId: 'trusted-thread', userId: 'owner', catId: null, content: '我来聊', timestamp: Date.now() + 1000,
    from: { kind: 'external' } };
  f.host.messaging.get = async () => source;
  const delivery = { kind: 'message', deliveryId: 'delivery', threadId: 'trusted-thread', envelope: { messageId: source.id } };
  await f.runtime.ownerDelivery(delivery);
  assert.equal((await f.runtime.status()).policies[0].mode, 'active');
  source = { ...source, from: { kind: 'user', userId: 'owner' } };
  await f.runtime.ownerDelivery(delivery);
  const paused = (await f.runtime.status()).policies[0];
  assert.equal(paused.mode, 'owner');
  await f.runtime.ownerDelivery(delivery);
  assert.equal((await f.runtime.status()).policies[0].epoch, paused.epoch);
});

test('local takeover acknowledgement does not wait for an unresponsive account status endpoint', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  f.client.identity = () => new Promise(() => {});
  const result = await Promise.race([f.runtime.dispatch({ action: 'pause_all' }, owner()), new Promise(resolve => setTimeout(() => resolve(null), 50))]);
  assert.notEqual(result, null);
  assert.equal(result.globalPause, true);
});

test('global takeover also cancels an authorization still waiting for model preparation, including a new conversation', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  let release, entered;
  const prepared = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { entered = resolve; });
  f.runtime.model.prepare = async () => { entered(); return prepared; };
  const activation = f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  await preparing;
  await f.runtime.dispatch({ action: 'pause_all' }, owner());
  release({ sessionId: 'late', generation: 1, threadId: 'isolated', consumedCursor: 0 });
  await assert.rejects(activation, /接管|变化|changed/);
  assert.equal((await f.runtime.status()).policies.length, 0);
});

test('older audit records remain reachable through bounded history pages after the live view fills', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: false, replies: true, intervalMinutes: 180, maxTurns: 200, confirm: true, modelFingerprint: 'preview' }, owner());
  f.client.submit = async run => ({ sendId: run.id, state: 'accepted' });
  for (let n = 0; n < 105; n++) await f.runtime.service.incoming('clowder', { id: `history-${n}`, threadId: 'room@chatroom', direction: 'incoming', body: '聊读书', createdAt: Date.now() + 1000 });
  const seen = new Set(); let cursor;
  do {
    const page = await f.runtime.dispatch({ action: 'history', ...(cursor === undefined ? {} : { cursor }) }, owner());
    assert.ok(page.items.length <= 50);
    for (const run of page.items) seen.add(run.id);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.size, 105);
});

test('the UI receives an initiative acknowledgement only after its durable run record exists', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), writing = new Promise(resolve => { entered = resolve; });
  const original = f.host.storage.compareAndSet;
  let delayed = false;
  f.host.storage.compareAndSet = async (key, revision, value) => {
    if (!delayed && value.runs && Object.keys(value.runs).length) { delayed = true; entered(); await gate; }
    return original(key, revision, value);
  };
  const operation = f.runtime.dispatch({ action: 'initiate', policyId: (await f.runtime.status()).policies[0].id, operationId: 'durable-request' }, owner());
  await writing;
  const acknowledgedEarly = await Promise.race([operation.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 20))]);
  release(); await operation; await f.runtime.drain();
  assert.equal(acknowledgedEarly, false);
  assert.equal((await f.runtime.status()).runs.length, 1);
});

test('native process loss and re-preparation never silently resume existing conversation grants', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  f.runtime.supervisor.client = null;
  f.runtime.supervisor.onExit?.();
  await f.runtime.drain();
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  assert.equal((await f.runtime.status()).policies[0].mode, 'owner');
  assert.equal(f.sends.length, 0);
});
