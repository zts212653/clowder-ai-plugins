import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';

function memoryStorage(): FeatureContext['storage'] {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let nextRevision = 0;
  return {
    get: async (key) => entries.get(key),
    list: async () => Object.fromEntries(entries),
    set: async (key, value) => {
      const revision = ++nextRevision;
      entries.set(key, { revision, value });
      return { revision };
    },
    compareAndSet: async (key, expectedRevision, value) => {
      const current = entries.get(key);
      if ((current?.revision ?? null) !== expectedRevision) return { applied: false };
      const revision = ++nextRevision;
      entries.set(key, { revision, value });
      return { applied: true, revision };
    },
    delete: async (key, expectedRevision) => {
      const current = entries.get(key);
      if (current === undefined || (expectedRevision !== undefined && current.revision !== expectedRevision)) {
        return { deleted: false };
      }
      entries.delete(key);
      return { deleted: true, revision: ++nextRevision };
    },
  };
}

test('arm state is scoped, bounded, stored, and expires closed without operator identity', async () => {
  let now = Date.parse('2026-09-23T00:00:00.000Z');
  const storage = memoryStorage();
  const armStore = new WeChatVisibleReaderArmStore({ storage, now: () => now });

  await assert.rejects(armStore.arm({ minutes: 31 }), /between 1 and 30/);
  const armed = await armStore.arm({ minutes: 10 });
  assert.equal(armed.armed, true);
  assert.equal(armed.remainingMs, 600_000);
  assert.equal(armed.expiresAt, '2026-09-23T00:10:00.000Z');
  assert.equal(Object.hasOwn(armed, 'armedBy'), false);
  assert.deepEqual((await storage.get('visible-conversation-arm'))?.value, {
    scope: 'visible-conversation',
    expiresAt: now + 600_000,
  });

  const anotherView = new WeChatVisibleReaderArmStore({ storage, now: () => now });
  assert.equal((await anotherView.status()).armed, true);
  now += 600_001;
  assert.deepEqual(await anotherView.status(), { armed: false, remainingMs: 0 });
  assert.equal(await storage.get('visible-conversation-arm'), undefined);
});

test('malformed storage and storage failures never authorize a read', async () => {
  const storage = memoryStorage();
  const armStore = new WeChatVisibleReaderArmStore({ storage });
  await storage.set('visible-conversation-arm', { scope: 'wrong', expiresAt: Date.now() + 10_000 });
  assert.equal(await armStore.isArmed(), false);
  const unavailable = new WeChatVisibleReaderArmStore({
    storage: { ...storage, get: async () => { throw new Error('storage unavailable'); } },
  });
  assert.equal(await unavailable.isArmed(), false);
});

test('disarm revokes immediately and a later activation cannot inherit an earlier arm', async () => {
  const storage = memoryStorage();
  const first = new WeChatVisibleReaderArmStore({ storage });
  await first.arm({ minutes: 10 });
  await first.disarm();
  assert.equal((await first.status()).armed, false);
  await first.arm({ minutes: 10 });
  const second = new WeChatVisibleReaderArmStore({ storage });
  await second.disarm();
  assert.equal((await second.status()).armed, false);
});
