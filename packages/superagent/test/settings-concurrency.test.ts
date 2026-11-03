import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema } from '../src/state.js';
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
    runtime.actions['superagent.choose']({ input: { selection, id } }, undefined, {
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
    choose('thread', 'source-a'),
    choose('thread', 'source-b'),
  ]);
  const saved = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
  assert.equal(saved.coordinatorId, 'coordinator');
  assert.deepEqual(saved.workerIds, ['worker']);
  assert.deepEqual(saved.threadIds.sort(), ['source-a', 'source-b']);
  assert.equal(f.threads.size, before + 1, 'concurrent refreshes share the one main conversation');
  await runtime.stop({ reason: 'test' });
});
