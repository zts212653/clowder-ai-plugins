import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema } from '../src/state.js';
import { fixture } from './fixture.js';

test('following can start with only automatic pins and no manual selection', async () => {
  const f = fixture();
  f.host.threads.list = async (options) => options && 'pinnedOnly' in options ? [f.threads.get('source-b')!] : [];
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, threadIds: [] });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.enable']({}, undefined, {
    kind: 'owner-operation', userId: 'owner', pluginInstanceId: f.host.pluginInstanceId,
    operationKey: 'activity', actionId: 'enable', requestId: 'start-auto-only', confirmed: true,
    signal: new AbortController().signal, assertCurrent: async () => {},
  });
  assert.equal(f.subscriptions.has('source-b'), true);
  assert.deepEqual(preferencesSchema.parse(f.rows.get('preferences')?.value).threadIds, []);
  await runtime.stop({ reason: 'test' });
});

test('pinned watching defaults on, follows pin changes and preserves manual choices without creating Work', async () => {
  const f = fixture();
  const pinned = new Set(['source-b']);
  f.host.threads.list = async (options) => [...f.threads.values()].filter((thread) =>
    (!options?.threadIds || options.threadIds.includes(thread.id)) &&
    (!options || !('pinnedOnly' in options) || !options.pinnedOnly || pinned.has(thread.id)));
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ['source-a'] });
  const runtime = await startSuperagent(f.host);
  assert.equal(f.subscriptions.has('source-b'), true, 'a pinned source is watched by default');
  assert.deepEqual(preferencesSchema.parse(f.rows.get('preferences')?.value).threadIds, ['source-a']);
  pinned.delete('source-b');
  pinned.add('outside');
  await runtime.actions['superagent.tick']({});
  assert.equal(f.subscriptions.has('source-b'), false);
  assert.equal(f.subscriptions.has('outside'), true);
  assert.equal(f.subscriptions.has('source-a'), true);
  f.host.config.get = async (key) => key === 'watchPinned' ? false : undefined;
  await runtime.actions['superagent.tick']({});
  assert.equal(f.subscriptions.has('outside'), false);
  assert.equal(f.subscriptions.has('source-a'), true, 'turning automatic watching off never removes manual choices');
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('automatic pinned scope reads beyond 50 entries and excludes the assistant and its coordination conversation', async () => {
  const f = fixture();
  const pinned = Array.from({ length: 53 }, (_, index) => ({ ...f.threads.get('source-a')!, id: `pin-${index}`, lastActiveAt: 100 - index }));
  for (const thread of pinned) f.threads.set(thread.id, thread);
  f.host.threads.list = async (options) => {
    if (options && 'pinnedOnly' in options && options.pinnedOnly) {
      const rows = [...pinned, ...[...f.threads.values()].filter((thread) => thread.title?.includes('我的助手'))];
      const start = options.before ? rows.findIndex((thread) => thread.id === options.before?.id) + 1 : 0;
      return rows.slice(start, start + (options.limit ?? 50));
    }
    return [...f.threads.values()].filter((thread) => !options?.threadIds || options.threadIds.includes(thread.id));
  };
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: [] });
  const runtime = await startSuperagent(f.host);
  assert.equal(pinned.every((thread) => f.subscriptions.has(thread.id)), true);
  const scope = await runtime.actions['superagent.settings']({}) as { data: { selected: string[]; automaticCount: number; effectiveCount: number } };
  assert.deepEqual(scope.data.selected, []);
  assert.equal(scope.data.automaticCount, 53);
  assert.equal(scope.data.effectiveCount, 53);
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});
