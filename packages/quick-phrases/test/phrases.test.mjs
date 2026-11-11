import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickPhrases } from '../src/phrases.ts';

function fixture() {
  const entries = new Map();
  let revision = 0;
  const storage = {
    async get(key) {
      return structuredClone(entries.get(key));
    },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: structuredClone(value) });
      return { applied: true };
    },
  };
  const invoke = (method, { userId = 'owner-a', body, query, active = true } = {}) =>
    createQuickPhrases(storage)({ request: { method, body, query } }, active ? {
      kind: 'owner-http-request',
      userId,
      operation: method === 'GET' ? 'read' : 'write',
      async assertCurrent() {},
    } : undefined);
  const list = async (query, userId) => {
    const result = await invoke('GET', { query, userId });
    assert.equal(result.status, 200);
    return JSON.parse(result.body);
  };
  return { invoke, list };
}

test('saved text survives handler recreation, searches case-insensitively and pages newest-first', async () => {
  const { invoke, list } = fixture();
  for (let index = 1; index <= 6; index++) {
    const saved = await invoke('POST', { body: { text: `Review 任务 ${index}` } });
    assert.equal(saved.status, 200);
  }
  assert.deepEqual((await list({})).items.map(({ text }) => text), [6, 5, 4, 3, 2].map((i) => `Review 任务 ${i}`));
  const last = await list({ page: '2' });
  assert.deepEqual(last.items.map(({ text }) => text), ['Review 任务 1']);
  assert.equal(last.totalPages, 2);
  assert.equal((await list({ q: 'review 任务 3' })).items[0].text, 'Review 任务 3');

  await invoke('POST', { body: { text: 'Review 任务 6' } });
  assert.equal((await list({})).totalPages, 2);
  assert.equal((await list({ page: '2' })).items.length, 1);

  assert.equal((await invoke('DELETE', { body: { id: last.items[0].id } })).status, 200);
  const clamped = await list({ page: '2' });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.totalPages, 1);
  assert.equal(clamped.items.length, 5);
});

test('only the authenticated owner can see and delete a saved phrase', async () => {
  const { invoke, list } = fixture();
  await invoke('POST', { body: { text: '  第一行\n第二行  ' } });
  const [saved] = (await list({})).items;
  assert.equal(saved.text, '  第一行\n第二行  ');
  assert.deepEqual((await list({}, 'owner-b')).items, []);
  assert.equal((await invoke('DELETE', { userId: 'owner-b', body: { id: saved.id } })).status, 200);
  assert.deepEqual((await list({})).items, [saved]);
  assert.equal((await invoke('GET', { active: false })).status, 403);
  assert.equal((await invoke('POST', { body: { text: ' \n ' } })).status, 400);
});
