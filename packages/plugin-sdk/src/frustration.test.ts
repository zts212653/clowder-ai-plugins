import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrustrationClient } from './frustration.js';
import { definePlugin } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';
const input = { issueId: 'issue', sourceRevision: 'r1', expectedDraftId: null, draftId: 'draft' };
test('source client fails unavailable, refuses authority input and checks returned correlation', async () => {
  await assert.rejects(createFrustrationClient(undefined, () => {}).getSource('issue'), /unavailable/);
  let calls = 0;
  const host = { getSource: async () => null, linkDraft: async () => { calls++; return { outcome: 'linked' as const, draftId: 'other', sourceRevision: 'r1' }; } };
  const client = createFrustrationClient(host, () => {});
  await assert.rejects(client.linkDraft({ ...input, userId: 'forged' } as typeof input)); assert.equal(calls, 0);
  await assert.rejects(client.linkDraft(input), /mismatch/);
  assert.equal(await client.getSource('issue'), null);
  await assert.rejects(client.getSource(''));
});
test('source grant and lifecycle are checked before and after Host access', async () => {
  let active = true; const capabilities: string[] = ['frustration.read']; let calls = 0;
  const client = createFrustrationClient({ getSource: async () => { calls++; active = false; return null; }, linkDraft: async () => { calls++; return { outcome: 'conflict' }; } }, needed => {
    if (!active) throw new Error('stopped'); for (const cap of needed) if (!capabilities.includes(cap)) throw new Error('missing '+cap);
  });
  await assert.rejects(client.linkDraft(input), /frustration.link/); assert.equal(calls, 0);
  await assert.rejects(client.getSource('issue'), /stopped/); assert.equal(calls, 1);
});

test('module source port enforces both feature grants and snapshots its minimal response', async () => {
  const source = { issueId: 'issue', status: 'confirmed' as const, threadId: 'thread', userId: 'owner', signalType: 'user_report' as const,
    signalDetail: { publicHint: 'hint' }, recentMessageCount: 2, communityIssueDraftId: null, sourceRevision: 'r1' };
  for (const caps of [[], ['frustration.read'], ['frustration.link'], ['frustration.read', 'frustration.link']]) {
    let reads = 0, writes = 0;
    let read!: () => Promise<unknown>, link!: () => Promise<unknown>;
    const manifest = { pluginId: 'dev.example.source', version: '1.0.0', contractVersion: '0.1.0', name: 'Source',
      features: [{ id: 'source', name: 'Source', resources: [], contributions: [], capabilities: caps }], contributions: [], runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } };
    const module = definePluginModule(candidate => definePlugin({ manifest: candidate, activate: { source: ctx => {
      read = () => ctx.frustration.getSource('issue'); link = () => ctx.frustration.linkDraft(input); return { actions: {} };
    } } }));
    const active = await module.create(manifest).start({ frustration: {
      getSource: async () => { reads++; return source; },
      linkDraft: async () => { writes++; return { outcome: 'already_linked', draftId: 'draft', sourceRevision: 'r1' }; },
    } } as unknown as ModulePluginHostShape);
    if (caps.includes('frustration.read')) { const result = await read(); assert.deepEqual(result, source); assert.notEqual(result, source); }
    else await assert.rejects(read(), /frustration.read/);
    if (caps.length === 2) await link(); else await assert.rejects(link(), /not granted/);
    assert.equal(reads, caps.includes('frustration.read') ? 1 : 0); assert.equal(writes, caps.length === 2 ? 1 : 0);
    await active.stop(); await assert.rejects(read()); await assert.rejects(link());
  }
});
