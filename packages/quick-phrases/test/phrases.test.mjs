import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickPhrases } from '../src/phrases.ts';

function fixture(phrases = []) {
  const entries = new Map();
  let revision = 0;
  if (phrases.length) entries.set(`quick-phrases:${Buffer.from('owner-a').toString('base64url')}`, { revision: ++revision, value: phrases });
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
  return { invoke, list, storage };
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

test('successful selections persist and rank by count before searching and paging', async () => {
  const { invoke, list, storage } = fixture();
  for (let index = 1; index <= 6; index++) {
    await invoke('POST', { body: { text: `Review ${index}` } });
  }
  const [oldest] = (await list({ page: '2' })).items;
  const [newest, second] = (await list({})).items;
  assert.equal((await invoke('POST', { body: { id: oldest.id } })).status, 200);
  assert.equal((await invoke('POST', { body: { id: second.id } })).status, 200);
  assert.equal((await invoke('POST', { body: { id: oldest.id } })).status, 200);
  assert.deepEqual((await list({})).items.map(({ text }) => text), ['Review 1', 'Review 5', 'Review 6', 'Review 4', 'Review 3']);
  assert.deepEqual((await list({ page: '2' })).items.map(({ text }) => text), ['Review 2']);
  assert.deepEqual((await list({ q: 'REVIEW' })).items.map(({ id }) => id).slice(0, 3), [oldest.id, second.id, newest.id]);
  assert.equal((await list({})).items[0].useCount, 2);
  assert.equal((await list({})).items[0].useCount, 2);
  await invoke('POST', { body: { text: oldest.text } });
  assert.equal((await list({})).items[0].useCount, 2);
  await invoke('POST', { body: { id: newest.id } });
  assert.deepEqual((await list({})).items.map(({ id }) => id).slice(0, 3), [oldest.id, newest.id, second.id]);

  const recreated = createQuickPhrases(storage);
  const result = await recreated({ request: { method: 'GET', query: {} } }, {
    kind: 'owner-http-request', userId: 'owner-a', operation: 'read', async assertCurrent() {},
  });
  assert.equal(JSON.parse(result.body).items[0].useCount, 2);
  assert.equal((await invoke('DELETE', { body: { id: oldest.id } })).status, 200);
  assert.equal((await list({})).items[0].id, newest.id);
});

test('legacy phrases start at zero and selection cannot write another owner or unknown phrase', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const { invoke, list } = fixture([{ id, text: 'Existing phrase' }]);
  assert.equal((await list({})).items[0].text, 'Existing phrase');
  assert.equal((await invoke('POST', { body: { id }, userId: 'owner-b' })).status, 404);
  assert.equal((await invoke('POST', { body: { id }, active: false })).status, 403);
  assert.equal((await invoke('POST', { body: { id: 'invalid' } })).status, 400);
  assert.equal((await invoke('POST', { body: { id: '00000000-0000-4000-8000-000000000002' } })).status, 404);
  assert.equal((await invoke('POST', { body: { id } })).status, 200);
  assert.equal((await list({})).items[0].useCount, 1);
  assert.deepEqual((await list({}, 'owner-b')).items, []);
});

test('a selection re-reads a competing revision and increments only once', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const { storage, list } = fixture([{ id, text: 'Existing phrase', useCount: 3 }]);
  let writes = 0;
  const handle = createQuickPhrases({
    ...storage,
    async compareAndSet(key, revision, value) {
      writes++;
      if (writes === 1) {
        const competitor = value.map((phrase) =>
          phrase.id === id ? { ...phrase, useCount: 10 } : phrase);
        assert.equal((await storage.compareAndSet(key, revision, competitor)).applied, true);
        return { applied: false };
      }
      return storage.compareAndSet(key, revision, value);
    },
  });
  const result = await handle({ request: { method: 'POST', body: { id } } }, {
    kind: 'owner-http-request', userId: 'owner-a', operation: 'write', async assertCurrent() {},
  });
  assert.equal(result.status, 200);
  assert.equal(writes, 2);
  assert.equal((await list({})).items[0].useCount, 11);
});

test('a selection reports 409 after three unapplied CAS attempts without losing data', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const { storage, list } = fixture([{ id, text: 'Existing phrase', useCount: 3 }]);
  let writes = 0;
  const handle = createQuickPhrases({
    ...storage,
    async compareAndSet() {
      writes++;
      return { applied: false };
    },
  });
  const result = await handle({ request: { method: 'POST', body: { id } } }, {
    kind: 'owner-http-request', userId: 'owner-a', operation: 'write', async assertCurrent() {},
  });
  assert.equal(result.status, 409);
  assert.equal(writes, 3);
  assert.equal((await list({})).items[0].useCount, 3);
});

test('ordinary save keeps its single CAS attempt and reports 409 on conflict', async () => {
  const { storage, list } = fixture();
  let writes = 0;
  const handle = createQuickPhrases({
    ...storage,
    async compareAndSet() {
      writes++;
      return { applied: false };
    },
  });
  const result = await handle({ request: { method: 'POST', body: { text: 'New phrase' } } }, {
    kind: 'owner-http-request', userId: 'owner-a', operation: 'write', async assertCurrent() {},
  });
  assert.equal(result.status, 409);
  assert.equal(writes, 1);
  assert.deepEqual((await list({})).items, []);
});

test('GET exposes an actionable insertion receipt without persisting it', async () => {
  const { invoke, list, storage } = fixture();
  await invoke('POST', { body: { text: 'Receipt phrase' } });
  const [item] = (await list({})).items;
  assert.deepEqual(item.onInserted, {
    request: { method: 'POST', path: 'phrases', body: { id: item.id } },
    notifyFailure: false,
  });
  const stored = await storage.get(`quick-phrases:${Buffer.from('owner-a').toString('base64url')}`);
  assert.ok(stored);
  assert.equal('onInserted' in stored.value[0], false);
  assert.equal((await invoke('POST', { body: item.onInserted.request.body })).status, 200);
  assert.equal((await list({})).items[0].useCount, 1);
});

test('invalid persisted counts are rejected at the storage boundary', async () => {
  for (const useCount of [-1, 1.5, 'two']) {
    const { invoke } = fixture([{ id: '00000000-0000-4000-8000-000000000001', text: 'Existing phrase', useCount }]);
    assert.equal((await invoke('GET')).status, 500);
  }
});

test('saving and recording usage are mutually exclusive POST operations', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const existing = { id, text: 'Existing phrase', useCount: 2 };
  const { invoke, list } = fixture([existing]);
  assert.equal((await invoke('POST', { body: { id, text: 'A new phrase' } })).status, 400);
  assert.equal((await invoke('POST', { body: { id: null, text: 'A new phrase' } })).status, 400);
  assert.deepEqual((await list({})).items, [
    {
      ...existing,
      onInserted: {
        request: { method: 'POST', path: 'phrases', body: { id } },
        notifyFailure: false,
      },
    },
  ]);
});
