import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema, readPreferences } from '../src/state.js';
import { fixture } from './fixture.js';

test('assistant, execution members and watched conversations are separate settings that preserve each other', async () => {
  const declaration = validateManifest(parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')));
  assert.ok(declaration.valid, JSON.stringify(declaration.errors));
  assert.ok(declaration.manifest.configuration);
  const fields = declaration.manifest.configuration;
  assert.equal(fields.find((field) => field.key === 'coordinatorId')?.kind, 'member');
  for (const [key, kind] of [['workerIds', 'member'], ['threadIds', 'thread']]) {
    const field = fields.find((field) => field.key === key);
    assert.equal(field?.kind, kind);
    assert.equal(field?.multiple, true);
  }
  assert.ok(!fields.some((field) => ['assistant', 'workers', 'scope'].includes(field.key)));
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  f.config.delete('coordinatorId');
  f.config.set('workerIds', '[]');
  f.config.set('threadIds', '[]');
  const runtime = await startSuperagent(f.host);
  try {
    f.config.set('coordinatorId', 'coordinator');
    f.config.set('workerIds', '["coordinator","worker"]');
    f.config.set('threadIds', '["source-a"]');
    await runtime.configRefresh?.();
    f.config.set('coordinatorId', 'worker');
    f.config.set('workerIds', '["coordinator"]');
    await runtime.configRefresh?.();
    const saved = await readPreferences(f.host);
    assert.equal(saved.coordinatorId, 'worker', 'assistant selection replaces only the single assistant');
    assert.deepEqual(saved.workerIds, ['coordinator'], 'execution supports multiple members, including the assistant');
    assert.deepEqual(saved.threadIds, ['source-a']);
    assert.equal(f.subscriptions.has('source-a'), false, 'selection alone does not start watching the chosen source');
    assert.equal(f.sent.size, 0, 'changing configuration does not invoke members');
    const stored = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
    assert.equal('coordinatorId' in stored, false);
    assert.equal('workerIds' in stored, false);
    assert.equal('threadIds' in stored, false);
  } finally {
    await runtime.stop({ reason: 'test' });
  }
});

test('configuration does not read member or conversation directories or retain row-selection actions', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  let directoryReads = 0;
  f.host.threads.list = async () => {
    directoryReads++;
    return [];
  };
  const runtime = await startSuperagent(f.host);
  try {
    await runtime.configRefresh?.();
    for (const method of ['superagent.assistant', 'superagent.workers', 'superagent.settings', 'superagent.choose', 'superagent.page']) {
      assert.equal(runtime.actions[method], undefined);
    }
    assert.equal(directoryReads, 0);
    assert.equal(await f.host.storage.get('directory-page'), undefined);
    assert.equal(f.subscriptions.has('source-a'), false);
  } finally {
    await runtime.stop({ reason: 'test' });
  }
});

test('older selected conversations remain configured while paused and can be removed without directory paging', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, started: true });
  const source = f.threads.get('source-a')!;
  f.threads.set('older', { ...source, id: 'older', lastActiveAt: 0 });
  f.config.set('threadIds', '["source-a","older"]');
  f.host.threads.list = async () => {
    throw new Error('configuration must not depend on directory pages');
  };
  const runtime = await startSuperagent(f.host);
  try {
    assert.ok(f.subscriptions.has('older'));
    assert.equal((await readPreferences(f.host)).enabled, false);
    f.config.set('threadIds', '["source-a"]');
    await runtime.configRefresh?.();
    assert.equal(f.subscriptions.has('older'), false);
    assert.equal(f.subscriptions.has('source-a'), true);
    assert.equal((await readPreferences(f.host)).enabled, false);
    assert.equal(f.sent.size, 0);
  } finally {
    await runtime.stop({ reason: 'test' });
  }
  await assert.rejects(async () => runtime.configRefresh?.(), /stopped/);
});
