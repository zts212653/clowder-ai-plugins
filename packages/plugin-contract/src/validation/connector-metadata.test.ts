import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function manifest(): Record<string, unknown> {
  return { pluginId: 'official.connector.fixture', version: '1.0.0', contractVersion: '0.1.0', name: 'Fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], }],
    permissions: { label: '飞书' }, steps: [{ text: 'Webhook step', mode: 'webhook' }, { text: 'WebSocket step', mode: 'websocket' }, { text: 'Configure' }] };
}

test('keeps old manifests valid when original optional UI metadata is absent', () => {
  const value = manifest(); delete value.permissions; value.steps = [{ text: 'Configure' }];
  assert.equal(validateManifest(value).valid, true);
});
