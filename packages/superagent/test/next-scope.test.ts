import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema } from '../src/state.js';
import { fixture } from './fixture.js';

test('restores the saved manual scope from alpha.19 when new Host fields are unset', async () => {
  const f = fixture();
  f.config.clear();
  const legacy = { ...f.preferences, started: true, coordinatorId: 'coordinator', workerIds: ['worker'], threadIds: ['source-a'] };
  await f.host.storage.set('preferences', legacy);
  const runtime = await startSuperagent(f.host);
  assert.equal(f.subscriptions.has('source-a'), true);
  assert.equal(f.subscriptions.has('source-b'), false);
  assert.deepEqual(preferencesSchema.parse(f.rows.get('preferences')?.value), legacy);
  await runtime.stop({ reason: 'test' });
});

test('explicit Host scope overrides legacy choices, including an empty selection', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ['source-a'] });
  f.config.set('threadIds', '["source-b"]');
  const runtime = await startSuperagent(f.host);
  assert.equal(f.subscriptions.has('source-b'), true);
  assert.equal(f.subscriptions.has('source-a'), false);
  f.config.set('threadIds', '[]');
  await runtime.configRefresh?.();
  assert.equal(f.subscriptions.has('source-b'), false);
  assert.deepEqual(preferencesSchema.parse(f.rows.get('preferences')?.value).threadIds, ['source-a']);
  await runtime.stop({ reason: 'test' });
});
