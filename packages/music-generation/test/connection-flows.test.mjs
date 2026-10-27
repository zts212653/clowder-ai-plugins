import assert from 'node:assert/strict';
import test from 'node:test';
import { MusicConnectionFlows } from '../dist/connection-flows.js';

function storage() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return structuredClone(rows.get(key)); },
    async compareAndSet(key, revision, value) {
      if ((rows.get(key)?.revision ?? null) !== revision) return { applied: false };
      rows.set(key, { revision: (revision ?? 0) + 1, value: structuredClone(value) });
      return { applied: true };
    },
  };
}

function harness(overrides = {}) {
  let clock = 1000;
  let sequence = 0;
  const calls = { begun: [], observed: [], canceled: [] };
  const options = {
    storage: storage(),
    helper: {
      async begin(input) { calls.begun.push(input); return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=public-challenge' }; },
      async observe(id) { calls.observed.push(id); return { state: 'pending' }; },
      async cancel(id) { calls.canceled.push(id); },
    },
    assertCurrent: async () => {},
    now: () => clock,
    createId: () => `flow-${++sequence}`,
    lifetimeMs: 600_000,
    ...overrides,
  };
  return { options, calls, create: () => new MusicConnectionFlows(options), advance: ms => { clock += ms; } };
}

test('a later settings request resumes the same pending flow without another helper', async () => {
  const h = harness();
  const begun = await h.create().begin('project-one');
  assert.ok(begun, 'starting a connection must return its durable pending record');
  assert.equal(begun.state, 'pending');
  assert.deepEqual(await h.create().poll(), begun);
  assert.deepEqual(await h.create().begin('project-one'), begun);
  assert.equal(h.calls.begun.length, 1);
  assert.deepEqual(h.calls.canceled, []);
});

test('a new project retires the old flow while retaining its history', async () => {
  const h = harness();
  const first = await h.create().begin('project-one');
  const second = await h.create().begin('project-two');
  assert.notEqual(first.flowId, second.flowId);
  assert.deepEqual(h.calls.canceled, [first.flowId]);
  const records = [...h.options.storage.rows.values()].map(row => row.value);
  assert.ok(records.some(row => row.flowId === first.flowId && row.state === 'canceled'));
  assert.equal((await h.create().poll()).projectId, 'project-two');
});

test('a completion arriving after a project change cannot become the current completion', async () => {
  let release;
  const h = harness();
  const first = await h.create().begin('project-one');
  h.options.helper.observe = () => new Promise(resolve => { release = resolve; });
  const pending = h.create().poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'poll must observe the existing helper');
  const second = await h.create().begin('project-two');
  release({ state: 'ready', flowId: first.flowId, projectId: 'project-one', completionRef: 'old-provider-result' });
  const observed = await pending;
  assert.equal(observed.flowId, second.flowId);
  assert.equal(observed.completionRef, undefined);
  assert.notEqual(observed.flowId, first.flowId);
});

test('provider completion must match the selected project and cannot leak arbitrary provider fields', async () => {
  const h = harness();
  const flow = await h.create().begin('project-one');
  h.options.helper.observe = async () => ({ state: 'ready', flowId: flow.flowId, projectId: 'project-two', completionRef: 'wrong-project', privateProviderDetail: 'must not persist' });
  assert.equal((await h.create().poll()).state, 'failed');
  assert.equal(JSON.stringify([...h.options.storage.rows]).includes('must not persist'), false);
  assert.equal(JSON.stringify([...h.options.storage.rows]).includes('wrong-project'), false);
});

test('expiry is explicit, drops the authorization link and never restarts consent on poll', async () => {
  const h = harness();
  await h.create().begin('project-one');
  h.advance(600_001);
  const state = await h.create().poll();
  assert.equal(state.state, 'expired');
  assert.equal(state.authorizationUrl, undefined);
  assert.equal(h.calls.begun.length, 1);
});

test('cancel survives settings reconstruction; it is not a provider credential revocation', async () => {
  const h = harness();
  const flow = await h.create().begin('project-one');
  assert.equal((await h.create().cancel()).state, 'canceled');
  assert.equal((await h.create().poll()).state, 'canceled');
  assert.deepEqual(h.calls.canceled, [flow.flowId]);
});

test('rejects non-Google or credential-bearing redirects and provider exception text', async () => {
  for (const url of ['https://example.com/login', 'http://accounts.google.com/login', 'https://accounts.google.com/o/oauth2/v2/auth?code=private-code']) {
    const h = harness();
    h.options.helper.begin = async () => ({ authorizationUrl: url });
    const result = await h.create().begin('project-one');
    assert.equal(result.state, 'failed');
    assert.equal(result.authorizationUrl, undefined);
    assert.equal(JSON.stringify([...h.options.storage.rows]).includes(url), false);
  }
  const h = harness();
  h.options.helper.begin = async () => { throw new Error('private provider diagnostic'); };
  assert.equal((await h.create().begin('project-one')).state, 'failed');
  assert.equal(JSON.stringify([...h.options.storage.rows]).includes('private provider diagnostic'), false);
});

test('request authority is required before launching any helper', async () => {
  const h = harness({ assertCurrent: async () => { throw new Error('owner request expired'); } });
  await assert.rejects(h.create().begin('project-one'), /owner request expired/);
  assert.equal(h.calls.begun.length, 0);
});

test('concurrent starts admit only one flow for the same project', async () => {
  const h = harness();
  const results = await Promise.all([h.create().begin('project-one'), h.create().begin('project-one')]);
  assert.equal(results[0].flowId, results[1].flowId);
  assert.equal(h.calls.begun.length, 1);
});

test('successful consent records only its opaque reference and remains distinct from saved credentials', async () => {
  const h = harness();
  const flow = await h.create().begin('project-one');
  h.options.helper.observe = async () => ({ state: 'ready', flowId: flow.flowId, projectId: flow.projectId, completionRef: 'provider-receipt', ignoredPrivateDetail: 'do not copy' });
  const ready = await h.create().poll();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.completionRef, 'provider-receipt');
  assert.equal(ready.authorizationUrl, undefined);
  assert.equal(JSON.stringify([...h.options.storage.rows]).includes('do not copy'), false);
  assert.deepEqual(await h.create().poll(), ready);
});

test('a callback for another flow on the same project is refused', async () => {
  const h = harness();
  await h.create().begin('project-one');
  h.options.helper.observe = async () => ({ state: 'ready', flowId: 'someone-else', projectId: 'project-one', completionRef: 'other-receipt' });
  assert.equal((await h.create().poll()).state, 'failed');
});

test('a fresh owner request recovers the URL after the old begin request expired', async () => {
  const h = harness();
  let current = true;
  let complete;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=public-challenge';
  h.options.assertCurrent = async () => { if (!current) throw new Error('old owner request expired'); };
  h.options.helper.begin = async input => {
    h.calls.begun.push(input);
    return new Promise(resolve => { complete = resolve; });
  };
  const begin = h.create().begin('project-one');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof complete, 'function');
  current = false;
  complete({ authorizationUrl: url });
  await assert.rejects(begin, /old owner request expired/);
  const next = new MusicConnectionFlows({ ...h.options, assertCurrent: async () => {} });
  h.options.helper.observe = async () => ({ state: 'pending', authorizationUrl: url });
  const restored = await next.poll();
  assert.equal(restored.state, 'pending');
  assert.equal(restored.authorizationUrl, url);
  assert.equal(h.calls.begun.length, 1);
});

test('corrupt pending metadata is refused instead of returned as settings data', async () => {
  const h = harness();
  const flow = await h.create().begin('project-one');
  const key = [...h.options.storage.rows.keys()].find(key => key.endsWith(flow.flowId));
  const row = h.options.storage.rows.get(key);
  row.value.unexpectedPrivateField = 'must not reach settings data';
  await assert.rejects(h.create().poll(), /invalid_connection_record/);
});
