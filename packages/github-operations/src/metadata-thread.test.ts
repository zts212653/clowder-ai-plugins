import assert from 'node:assert/strict';
import test from 'node:test';
import { findThreadMetadata } from './metadata-thread.js';
import { threadMappings } from './thread-mappings.js';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

const rows = Array.from({ length: 51 }, (_, i) => ({ id: 'thread-' + i, title: 'Thread',
  createdAt: 1, lastActiveAt: 100 - i, preferredCats: [], featureRefs: [], deepLinkUrl: '/thread/' + i }));

test('Community summary lookup uses owner-visible metadata pagination without content access', async () => {
  const calls: unknown[] = [];
  const threads = { list: async (input: any) => {
    calls.push(input);
    const start = input.before ? rows.findIndex(row => row.id === input.before.id) + 1 : 0;
    return rows.slice(start, start + input.limit);
  }, get: async () => { throw new Error('Content access forbidden'); } };
  assert.equal((await findThreadMetadata(threads, 'thread-50'))?.id, 'thread-50');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { limit: 50, before: { id: 'thread-49', lastActiveAt: 51 } });
});

test('an absent or inaccessible metadata summary does not fall back to a content read', async () => {
  const threads = { list: async () => [], get: async () => { throw new Error('Content access forbidden'); } };
  assert.equal(await findThreadMetadata(threads, 'not-owner-visible'), null);
});

test('a live paginated miss cannot establish absence after activity moves the target ahead of the cursor', async () => {
  let page = 0;
  const threads = { list: async () => ++page === 1 ? rows.slice(0, 50) : [] };
  await assert.rejects(findThreadMetadata(threads, 'thread-50'), /cannot confirm thread metadata/i);
});

test('an unconfirmed metadata traversal never replaces a persisted thread mapping', async () => {
  let creates = 0;
  const threads = { list: async (input: any) => input.before ? [] : rows.slice(0, 50) };
  const context = {
    threads: { get: (id: string) => findThreadMetadata(threads, id),
      create: async () => { creates++; return rows[0]; } },
    storage: { get: async () => ({ revision: 1, value: [{ key: 'case', threadId: 'thread-50', createdAt: 1 }] }),
      compareAndSet: async () => { throw new Error('mapping must not change'); } },
  } as unknown as FeatureContext;
  await assert.rejects(threadMappings(context).ensureByKey('case', { title: 'Existing case' }), /cannot confirm thread metadata/i);
  assert.equal(creates, 0);
});
