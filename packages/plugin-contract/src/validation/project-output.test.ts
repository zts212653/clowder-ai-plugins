import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function manifest() {
  return { pluginId: 'fixture.music', version: '0.1.0', contractVersion: '0.2.0', name: 'Output fixture',
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    contributions: [
      { type: 'identity', id: 'music', displayName: 'Music' },
      { type: 'media-source', id: 'audio', binding: 'music' },
      { type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' }, actions: [{ method: 'music.output' }] },
    ],
    features: [{ id: 'music', name: 'Music', resources: [], capabilities: ['plugin.state.get', 'plugin.state.set', 'project.output.create'],
      contributions: [{ type: 'identity', id: 'music' }, { type: 'media-source', id: 'audio' }, { type: 'mcp', id: 'native' }] }],
    projectOutputs: [{ method: 'music.output', producerMethod: 'music.generate', resultMethod: 'music.result', mediaSourceId: 'audio', mimeType: 'audio/mpeg', maxBytes: 1_048_576 }],
  };
}
test('admits a bounded, feature-owned output producer; never arbitrary filesystem writers', () => {
  const value = manifest();
  const accepted = validateManifest(value);
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  const unknown = structuredClone(value);
  Object.assign(unknown.projectOutputs[0]!, { projectRoot: '/tmp/arbitrary' });
  assert.equal(validateManifest(unknown).valid, false);
});
test('requires output grant, native declaration, distinct internal methods and matching media owner', () => {
  for (const change of [
    (v: ReturnType<typeof manifest>) => { v.features[0]!.capabilities = ['plugin.state.get', 'plugin.state.set']; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.mediaSourceId = 'missing'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.method = 'undeclared'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.producerMethod = 'music.output'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs.push(structuredClone(v.projectOutputs[0]!)); },
  ]) {
    const value = manifest(); change(value);
    assert.equal(validateManifest(value).valid, false);
  }
});
