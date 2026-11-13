import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema, runtimeSchema } from '../src/state.js';
import { fixture } from './fixture.js';

test('the settings UI may select different rows concurrently without losing scope or creating two Bot conversations', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', {
    ...f.preferences,
    enabled: false,
    coordinatorId: undefined,
    workerIds: [],
    threadIds: [],
  });
  const runtime = await startSuperagent(f.host);
  const before = f.threads.size;
  const create = f.host.threads.create;
  f.host.threads.create = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return create(input);
  };
  const choose = (selection: string, id: string) =>
    runtime.actions['superagent.choose']({ input: { selection, ...(selection === 'threads' ? { ids: ['source-a', 'source-b'] } : { id }) } }, undefined, {
      kind: 'owner-operation',
      userId: 'owner',
      pluginInstanceId: f.host.pluginInstanceId,
      operationKey: 'scope',
      actionId: 'choose',
      requestId: `select-${selection}`,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    });
  await Promise.all([
    choose('coordinator', 'coordinator'),
    choose('worker', 'worker'),
    choose('threads', 'sources'),
  ]);
  const saved = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
  assert.equal(saved.coordinatorId, 'coordinator');
  assert.deepEqual(saved.workerIds, ['worker']);
  assert.deepEqual(saved.threadIds.sort(), ['source-a', 'source-b']);
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  assert.equal(f.threads.size, before + 2, 'concurrent refreshes share one main and one coordination conversation');
  assert.equal([...f.threads.values()].filter((thread) => thread.id === state.mainThreadId).length, 1);
  assert.equal([...f.threads.values()].filter((thread) => thread.id === state.coordinationThreadId).length, 1);
  await runtime.stop({ reason: 'test' });
});
