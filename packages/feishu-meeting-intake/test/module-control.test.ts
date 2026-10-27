import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

// Exercise the shipped module surface, not a second test-only collector.
test('first explicit enable starts only the meeting control plane and stop revokes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-control-module-'));
  const spawn = childProcess.spawn, fetch = globalThis.fetch;
  let providerEffects = 0;
  childProcess.spawn = (() => { providerEffects++; throw new Error('First enable must not start a provider process'); }) as typeof spawn;
  syncBuiltinESMExports();
  globalThis.fetch = async () => { providerEffects++; throw new Error('First enable must not access the provider'); };
  try {
    const namespace = await import('../src/index.js') as unknown as {
      default?: { create(manifest: unknown): { start(host: unknown): Promise<{ actions: Record<string, (...args: unknown[]) => Promise<unknown>>; stop(input:{reason:string}): Promise<void> }> } };
    };
    assert.equal(typeof namespace.default?.create, 'function', 'installed root must expose the actual builtin module');
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.runtime.transport, 'builtin', 'retired broker must not be the production runtime');
    assert.deepEqual(manifest.contributions.filter((value: { type: string }) => value.type === 'identity').map((value: { id: string }) => value.id), ['feishu-meeting'], 'actual Host SDK messaging requires a declared authored identity');
    const state = new Map<string, { revision: number; value: unknown }>();
    const host = { pluginInstanceId:'installed-meeting',dataPath: directory, config: { async get() { return undefined; } },
      secrets: { async get() { throw new Error('First enable must not read account secrets'); } },
      storage: { async get(key: string) { return state.get(key); }, async list() { return Object.fromEntries(state); },
        async set(key: string, value: unknown) { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
        async compareAndSet(key: string, expected: number | null, value: unknown) { if ((state.get(key)?.revision ?? null) !== expected) return { applied: false }; const revision = (expected ?? 0) + 1; state.set(key, { revision, value }); return { applied: true, revision }; },
        async delete(key: string) { return { deleted: state.delete(key) }; } },
      tasks: {}, threads: {}, streams:{read:async function*(){}}, messaging: {get: async () => null,}, log() {} };
    const active = await namespace.default!.create(manifest).start(host);
    const owner = { kind: 'owner-operation', userId: 'fixture-owner', pluginInstanceId: 'installed-meeting',
      operationKey: 'account', actionId: 'status', requestId: 'status-1', signal: new AbortController().signal, async assertCurrent() {} };
    try {
      const status = await active.actions['meeting.status']!({ input: {} }, undefined, owner) as { data: { auth: string; collectionIntent: string; live: string } };
      assert.deepEqual(status.data, { auth: 'not_configured', collectionIntent: 'disabled', live: 'stopped' });
      assert.equal(providerEffects, 0);
      await active.stop({reason:'test'});
      await assert.rejects(() => active.actions['meeting.status']!({ input: {} }, undefined, owner), /revoked|stopped/);
    } finally { await active.stop({reason:'test'}); }
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports(); globalThis.fetch = fetch;
    await rm(directory, { recursive: true, force: true });
  }
});
