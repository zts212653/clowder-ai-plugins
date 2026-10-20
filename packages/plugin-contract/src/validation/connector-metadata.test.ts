import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function manifest(): Record<string, unknown> {
  return { pluginId: 'official.connector.fixture', version: '1.0.0', contractVersion: '0.1.0', name: 'Fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: [] }],
    permissions: { label: '飞书' }, steps: [{ text: 'Webhook step', mode: 'webhook' }, { text: 'WebSocket step', mode: 'websocket' }, { text: 'Configure' }] };
}

test('accepts original connector permissions label and optional step mode without changing grants', () => {
  const value = manifest();
  const result = validateManifest(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(value.features, [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: [] }]);
});

test('keeps old manifests valid when original optional UI metadata is absent', () => {
  const value = manifest(); delete value.permissions; value.steps = [{ text: 'Configure' }];
  assert.equal(validateManifest(value).valid, true);
});

test('original metadata remains closed and cannot carry grants, state or execution actions', () => {
  for (const permissions of [null, [], {}, { label: 1 }, { label: 'Group', grants: ['task.write'] }, { label: 'Group', adminOpenIds: ['untrusted'] }]) {
    assert.equal(validateManifest({ ...manifest(), permissions }).valid, false, JSON.stringify(permissions));
  }
  for (const step of [{ text: 'Step', mode: 1 }, { text: 'Step', mode: 'webhook', action: { method: 'unsafe' } }]) {
    assert.equal(validateManifest({ ...manifest(), steps: [step] }).valid, false);
  }
});
