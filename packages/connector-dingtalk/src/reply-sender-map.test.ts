import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createReplySenderMap } from './reply-sender-map.js';

function harness(options?: { setError?: Error; getError?: Error }) {
  const values = new Map<string, unknown>();
  const logs: Array<{ level: string; message: string }> = [];
  const context = {
    storage: {
      get: async (key: string) => {
        if (options?.getError !== undefined) throw options.getError;
        const value = values.get(key);
        return value === undefined ? undefined : { value, revision: 1 };
      },
      set: async (key: string, value: unknown) => {
        if (options?.setError !== undefined) throw options.setError;
        values.set(key, value);
        return { revision: 1 };
      },
      list: async () => Object.fromEntries([...values].map(([key, value]) => [key, { value, revision: 1 }])),
      delete: async (key: string) => ({ deleted: values.delete(key) }),
    },
    log: (level: string, message: string) => { logs.push({ level, message }); },
  } as unknown as FeatureContext;
  return { map: createReplySenderMap(context), values, logs };
}

const TTL = 24 * 60 * 60 * 1000;

async function waitFor(condition: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not met in time');
}

test('recorded inbound senders resolve independently by Host messageId', async () => {
  const { map } = harness();
  await map.record('host-message-1', { id: 'sender-1', name: 'Sender' });
  await map.record('host-message-2', { id: 'sender-2' });
  assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1', name: 'Sender' });
  assert.deepEqual(await map.resolve('host-message-2'), { id: 'sender-2' });
});

test('re-recording the same Host messageId overwrites the sender', async () => {
  const { map } = harness();
  await map.record('host-message-1', { id: 'sender-1', name: 'Sender' });
  await map.record('host-message-1', { id: 'sender-2' });
  assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-2' });
});

test('unknown Host messageId resolves to undefined (miss fallback)', async () => {
  const { map } = harness();
  await map.record('host-message-1', { id: 'sender-1' });
  assert.equal(await map.resolve('host-message-2'), undefined);
  assert.equal(await map.resolve(undefined), undefined);
});

test('entries resolve until the TTL boundary and expire past it', async () => {
  const { map } = harness();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    await map.record('host-message-1', { id: 'sender-1' });
    Date.now = () => 1_000_000 + TTL;
    assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1' });
    Date.now = () => 1_000_000 + TTL + 1;
    assert.equal(await map.resolve('host-message-1'), undefined);
  } finally {
    Date.now = realNow;
  }
});

test('expired resolve misses and deletes the stored key', async () => {
  const { map, values } = harness();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    await map.record('host-message-1', { id: 'sender-1' });
    assert.equal(values.has('reply-sender:host-message-1'), true);
    Date.now = () => 1_000_000 + TTL + 1;
    assert.equal(await map.resolve('host-message-1'), undefined);
    assert.equal(values.has('reply-sender:host-message-1'), false);
  } finally {
    Date.now = realNow;
  }
});

test('sweep evicts the oldest entries once the cap is reached', async () => {
  const { map, values } = harness();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    for (let index = 0; index < 2000; index += 1) {
      values.set(`reply-sender:old-${index}`, JSON.stringify({ version: 1, sender: { id: `old-${index}` }, storedAt: index }));
    }
    for (let index = 0; index < 50; index += 1) {
      await map.record(`host-message-${index}`, { id: `sender-${index}` });
    }
    await waitFor(() => !values.has('reply-sender:old-50'));
    assert.equal(values.has('reply-sender:old-0'), false);
    assert.equal(values.has('reply-sender:old-51'), true);
    assert.deepEqual(await map.resolve('host-message-49'), { id: 'sender-49' });
    assert.equal(values.has('reply-sender:host-message-0'), true);
  } finally {
    Date.now = realNow;
  }
});

test('sweep deletes expired entries alongside cap eviction', async () => {
  const { map, values } = harness();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    for (let index = 0; index < 1999; index += 1) {
      values.set(`reply-sender:old-${index}`, JSON.stringify({ version: 1, sender: { id: `old-${index}` }, storedAt: index }));
    }
    values.set('reply-sender:expired', JSON.stringify({ version: 1, sender: { id: 'expired' }, storedAt: 1_000_000 - TTL - 1 }));
    for (let index = 0; index < 50; index += 1) {
      await map.record(`host-message-${index}`, { id: `sender-${index}` });
    }
    await waitFor(() => !values.has('reply-sender:old-0'));
    assert.equal(values.has('reply-sender:expired'), false);
  } finally {
    Date.now = realNow;
  }
});

test('storage set failure logs a warning and does not throw from record', async () => {
  const { map, logs } = harness({ setError: new Error('storage down') });
  await map.record('host-message-1', { id: 'sender-1' });
  assert.equal(await map.resolve('host-message-1'), undefined);
  assert.equal(logs.some(log => log.level === 'warn' && log.message.includes('record failed')), true);
});

test('storage get failure logs a warning and resolves to undefined', async () => {
  const { map, logs } = harness({ getError: new Error('storage down') });
  assert.equal(await map.resolve('host-message-1'), undefined);
  assert.equal(logs.some(log => log.level === 'warn' && log.message.includes('lookup failed')), true);
});

test('corrupt stored entry resolves to undefined', async () => {
  const { map, values } = harness();
  values.set('reply-sender:corrupt-json', '{not json');
  values.set('reply-sender:legacy-shape', { version: 1, entries: {} });
  values.set('reply-sender:wrong-version', JSON.stringify({ version: 2, sender: { id: 'x' }, storedAt: 1 }));
  assert.equal(await map.resolve('corrupt-json'), undefined);
  assert.equal(await map.resolve('legacy-shape'), undefined);
  assert.equal(await map.resolve('wrong-version'), undefined);
});

test('background sweep failure only logs a warning and never rejects record', async () => {
  const values = new Map<string, unknown>();
  const logs: Array<{ level: string; message: string }> = [];
  const context = {
    storage: {
      get: async (key: string) => {
        const value = values.get(key);
        return value === undefined ? undefined : { value, revision: 1 };
      },
      set: async (key: string, value: unknown) => { values.set(key, value); return { revision: 1 }; },
      list: async () => { throw new Error('list down'); },
      delete: async (key: string) => ({ deleted: values.delete(key) }),
    },
    log: (level: string, message: string) => { logs.push({ level, message }); },
  } as unknown as FeatureContext;
  const map = createReplySenderMap(context);
  for (let index = 0; index < 50; index += 1) {
    await map.record(`host-message-${index}`, { id: `sender-${index}` });
  }
  await waitFor(() => logs.some(log => log.message.includes('sweep failed')));
  assert.equal(values.size, 50);
  assert.deepEqual(await map.resolve('host-message-49'), { id: 'sender-49' });
});
