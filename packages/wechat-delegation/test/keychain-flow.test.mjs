import assert from 'node:assert/strict';
import test from 'node:test';
import { KeychainFlow } from '../src/keychain-flow.mjs';
function fixture(overrides = {}) {
  const data = new Map(), calls = [];
  const storage = {
    get: async key => structuredClone(data.get(key)),
    compareAndSet: async (key, revision, value) => {
      const previous = data.get(key); if ((previous?.revision ?? null) !== revision) return { applied: false };
      const next = { revision: (previous?.revision ?? 0) + 1, value: structuredClone(value) }; data.set(key, next); return { applied: true };
    },
  };
  const context = { userId: 'owner', signal: new AbortController().signal };
  const options = { storage, assertOwner: async () => {}, beforeStart: async () => { calls.push('stop'); },
    execute: async () => { calls.push('system'); return { state: 'verified' }; }, cancel: async () => { calls.push('cancel'); }, ...overrides };
  return { flow: new KeychainFlow(options), data, calls, context, options };
}
test('system authorization is explicit, journaled before execution and retains every result without raw fields', async () => {
  const f = fixture();
  f.flow.execute = async () => { assert.equal((await f.flow.status()).state, 'requesting'); return { state: 'verified' }; };
  assert.equal((await f.flow.status()).state, 'idle');
  const first = await f.flow.begin(f.context), second = await f.flow.begin(f.context);
  assert.equal(first.state, 'verified'); assert.equal(second.state, 'verified'); assert.notEqual(first.operationId, second.operationId);
  const records = [...f.data.values()][0].value.records; assert.equal(Object.keys(records).length, 2);
  f.flow.execute = async () => ({ state: 'verified', secret: 'SENTINEL_KEYCHAIN_SECRET' });
  assert.equal((await f.flow.begin(f.context)).state, 'unknown');
  assert.equal(JSON.stringify([...f.data]).includes('SENTINEL'), false);
});
test('cancel before late authority validation prevents the system dialog, and stale cancellation cannot touch a new intent', async () => {
  let unblock; const pending = new Promise(resolve => { unblock = resolve; });
  const f = fixture({ beforeStart: () => pending }); const running = f.flow.begin(f.context);
  while ((await f.flow.status()).state === 'idle') await new Promise(resolve => setImmediate(resolve));
  const original = await f.flow.status(); await f.flow.cancel(f.context, original.operationId); unblock();
  assert.equal((await running).state, 'cancelled'); assert.deepEqual(f.calls, ['cancel']);
  f.flow.beforeStart = async () => {}; await f.flow.begin(f.context);
  await assert.rejects(f.flow.cancel(f.context, original.operationId), /原钥匙串操作/);
});
test('a stopped reader cannot undo already accepted system permission; restart exposes uncertainty and never opens a dialog', async () => {
  let resolve; const result = new Promise(done => { resolve = done; });
  const f = fixture({ execute: () => result }); const running = f.flow.begin(f.context);
  while ((await f.flow.status()).state !== 'requesting') await new Promise(done => setImmediate(done));
  const id = (await f.flow.status()).operationId; await f.flow.cancel(f.context, id);
  assert.equal((await f.flow.status()).state, 'unknown'); resolve({ state: 'verified' });
  assert.equal((await running).state, 'verified'); assert.equal((await f.flow.status()).cancelRequested, true);
  let finish; f.flow.execute = () => new Promise(done => { finish = done; }); const closing = f.flow.begin(f.context);
  while ((await f.flow.status()).state !== 'requesting') await new Promise(done => setImmediate(done));
  f.flow.deactivate(); finish({ state: 'verified' }); await assert.rejects(closing, /expired/);
  const restarted = new KeychainFlow({ ...f.options, execute: async () => { throw Error('must not run'); } });
  assert.equal((await restarted.status()).state, 'unknown');
});
