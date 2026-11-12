import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema, runtimeSchema } from '../src/state.js';
import { fixture } from './fixture.js';

const picker = z.object({
  render: z.literal('thread-picker'),
  data: z.object({ selected: z.array(z.string()), excluded: z.array(z.string()) }).strict(),
});
const owner = (instance: string) => ({
  kind: 'owner-operation' as const,
  userId: 'owner',
  pluginInstanceId: instance,
  operationKey: 'scope',
  actionId: 'choose',
  requestId: 'save-sources',
  signal: new AbortController().signal,
  assertCurrent: async () => {},
});

test('the native picker delegates titles, groups, pins and ordering to the Host without enumerating a second directory', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  const runtime = await startSuperagent(f.host);
  f.host.threads.list = async () => { throw new Error('The picker must use the native sidebar'); };
  const response = picker.parse(await runtime.actions['superagent.settings']({}));
  assert.deepEqual(response.data.selected, f.preferences.threadIds);
  const saved = runtimeSchema.parse((await f.host.storage.get('runtime'))?.value);
  assert.ok(response.data.excluded.includes(saved.mainThreadId!));
  assert.equal(f.sent.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('batch source selection is owner-only and preserves the other configuration and start state', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  const runtime = await startSuperagent(f.host);
  const input = { input: { botName: 'Unsaved form value', selection: 'threads', ids: ['source-b'] } };
  await assert.rejects(async () => runtime.actions['superagent.choose'](input), /插件设置/);
  const before = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
  const result = picker.parse(await runtime.actions['superagent.choose'](input, undefined, owner(f.host.pluginInstanceId)));
  const after = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
  assert.deepEqual(result.data.selected, ['source-b']);
  assert.deepEqual(after, { ...before, threadIds: ['source-b'] });
  assert.equal(f.subscriptions.has('source-b'), false, 'saving scope does not enable intake');
  assert.equal(f.sent.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('a missing or managed conversation rejects the whole save without changing the previous scope', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  const runtime = await startSuperagent(f.host);
  const before = await f.host.storage.get('preferences');
  const main = runtimeSchema.parse((await f.host.storage.get('runtime'))?.value).mainThreadId!;
  f.threads.set('work-thread', { ...f.threads.get('source-a')!, id: 'work-thread' });
  await f.host.storage.set('work:internal', {
    key: 'internal', title: 'Work', outcome: 'Result', workerId: 'worker', threadId: 'work-thread',
    sourceThreadId: 'source-a', sourceMessageId: 'request',
  });
  await f.host.storage.set('queue', { works: ['internal'] });
  assert.ok(picker.parse(await runtime.actions['superagent.settings']({})).data.excluded.includes('work-thread'));
  for (const id of ['not-visible', main, 'work-thread']) {
    await assert.rejects(async () => runtime.actions['superagent.choose'](
      { input: { selection: 'threads', ids: ['source-b', id] } }, undefined, owner(f.host.pluginInstanceId),
    ), /会话/);
    assert.deepEqual(await f.host.storage.get('preferences'), before);
  }
  const empty = picker.parse(await runtime.actions['superagent.choose'](
    { input: { selection: 'threads', ids: [] } }, undefined, owner(f.host.pluginInstanceId),
  ));
  assert.deepEqual(empty.data.selected, []);
  await runtime.stop({ reason: 'test' });
});

test('an upgrade retains older selections and the main conversation without using the old directory cursor', async () => {
  const f = fixture();
  const source = f.threads.get('source-a')!;
  f.threads.set('older', { ...source, id: 'older' });
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, threadIds: ['source-a', 'older'] });
  const oldPage = { before: { lastActiveAt: 50, id: 'old-position' } };
  await f.host.storage.set('directory-page', oldPage);
  const first = await startSuperagent(f.host);
  const initial = picker.parse(await first.actions['superagent.settings']({}));
  const originalMain = (await f.host.storage.get('runtime'))?.value;
  await first.stop({ reason: 'restart' });
  const next = await startSuperagent(f.host);
  assert.deepEqual(picker.parse(await next.actions['superagent.settings']({})), initial);
  assert.deepEqual((await f.host.storage.get('runtime'))?.value, originalMain);
  assert.deepEqual((await f.host.storage.get('directory-page'))?.value, oldPage);
  assert.equal(f.sent.size, 0);
  await next.stop({ reason: 'test' });
  await assert.rejects(async () => next.actions['superagent.settings']({}), /stopped/);
});

test('native selection is not truncated by the operation rows limit', async () => {
  const f = fixture();
  const source = f.threads.get('source-a')!;
  const ids = Array.from({ length: 215 }, (_, i) => `source-${i}`);
  ids.forEach((id) => f.threads.set(id, { ...source, id }));
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, threadIds: ids });
  const runtime = await startSuperagent(f.host);
  const response = picker.parse(await runtime.actions['superagent.settings']({}));
  assert.deepEqual(response.data.selected, ids);
  await runtime.stop({ reason: 'test' });
});
