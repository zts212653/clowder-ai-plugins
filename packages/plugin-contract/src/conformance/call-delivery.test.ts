import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '../index.js';

const base = {
  pluginId: 'test.call-delivery',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'Callable plugin',
  features: [{ id: 'chat', name: 'Chat', resources: [], capabilities: [] }],
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
} as const;

test('call is optional closed presentation metadata without a method selector', () => {
  assert.equal(validateManifest(base).valid, true);
  assert.equal(validateManifest({ ...base, call: { alias: 'dot', displayName: 'Dot' } }).valid, true);
  for (const call of [
    {},
    { alias: '', displayName: 'Dot' },
    { alias: 'dot', displayName: '' },
    { alias: 'dot', displayName: 'Dot', method: 'dot.deliver' },
    null,
  ]) {
    assert.equal(validateManifest({ ...base, call }).valid, false, JSON.stringify(call));
  }
});

test('fixed webhook contributions need no package-selected action method', () => {
  const webhook = { type: 'webhook', id: 'incoming', path: 'incoming', methods: ['POST'] } as const;
  const manifest = {
    ...base,
    contributions: [webhook],
    features: [{ ...base.features[0], contributions: [{ type: 'webhook', id: 'incoming' }] }],
  };
  assert.equal(validateManifest(manifest).valid, true);
});
