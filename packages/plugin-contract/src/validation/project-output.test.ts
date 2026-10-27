import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function manifest() {
  return { pluginId: 'fixture.music', version: '0.1.0', contractVersion: '0.3.1-candidate.0', name: 'Output fixture',
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    contributions: [
      { type: 'identity', id: 'music', displayName: 'Music' },
      { type: 'media-source', id: 'audio', binding: 'music' },
      { type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' } },
    ],
    features: [{ id: 'music', name: 'Music', resources: [], contributions: [{ type: 'identity', id: 'music' }, { type: 'media-source', id: 'audio' }, { type: 'mcp', id: 'native' }] }],
    projectOutputs: [{ method: 'music.output', producerMethod: 'music.generate', resultMethod: 'music.result', mcpId: 'native', mediaSourceId: 'audio', mimeType: 'audio/mpeg', maxBytes: 1_048_576 }],
  };
}
test('admits bounded output declarations without API grants or native method lists', () => {
  const value = manifest();
  const accepted = validateManifest(value);
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  if (accepted.valid) {
    assert.equal('capabilities' in accepted.manifest.features[0]!, false);
    assert.equal('actions' in accepted.manifest.contributions![2]!, false);
  }
  const unknown = structuredClone(value);
  Object.assign(unknown.projectOutputs[0]!, { projectRoot: '/tmp/arbitrary' });
  assert.equal(validateManifest(unknown).valid, false);
});
test('requires actual native and media declarations with matching ownership and distinct methods', () => {
  for (const change of [
    (v: ReturnType<typeof manifest>) => { v.features[0]!.contributions.pop(); },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.mediaSourceId = 'missing'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.mcpId = 'missing'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs[0]!.producerMethod = 'music.output'; },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs.push(structuredClone(v.projectOutputs[0]!)); },
    (v: ReturnType<typeof manifest>) => { v.projectOutputs.push({ ...v.projectOutputs[0]!, method: 'music.generate', producerMethod: 'second.generate', resultMethod: 'second.result' }); },
  ]) {
    const value = manifest(); change(value);
    assert.equal(validateManifest(value).valid, false);
  }
});

test('retired metadata is ignored and cannot authorize an undeclared native output', () => {
  const value = manifest();
  Object.assign(value.features[0]!, { capabilities: ['project.output.create'] });
  Object.assign(value.contributions[2]!, { actions: [{ method: 'music.output' }] });
  assert.equal(validateManifest(value).valid, true);
  value.projectOutputs[0]!.mcpId = 'missing';
  assert.equal(validateManifest(value).valid, false);
});

test('non-native and connection-test actions cannot route output operation methods', () => {
  for (const method of ['music.output', 'music.generate', 'music.result']) {
    const value = manifest();
    Object.assign(value, { test: { action: { method } } });
    assert.equal(validateManifest(value).valid, false);
    const tool = manifest();
    Object.assign(tool.contributions, { [tool.contributions.length]: {
      type: 'tool', id: 'bypass', name: 'bypass', inputSchema: {}, action: { method },
    } });
    assert.equal(validateManifest(tool).valid, false);
  }
});
