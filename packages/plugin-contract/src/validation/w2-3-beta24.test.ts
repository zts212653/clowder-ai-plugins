import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: 'dev.clowder.example',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.23',
    name: 'Example',
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        capabilities: ['plugin.config.read'],
      },
    ],
    runtime: { transport: 'builtin' },
    ...overrides,
  };
}

test('beta.24 admits ActionDef render row with confirm and enforces the confirm bound', () => {
  const manifest = baseManifest({
    configuration: [
      {
        key: 'authorization',
        label: 'Authorization',
        kind: 'operation',
        required: false,
        actions: [
          { id: 'list', label: 'List', render: 'status', action: { method: 'list' } },
          {
            id: 'revoke',
            label: 'Revoke',
            render: 'row',
            confirm: 'Revoke this conversation?',
            action: { method: 'revoke' },
            next: 'list',
          },
        ],
      },
    ],
  });
  assert.equal(validateManifest(manifest).valid, true);

  const actions = (manifest.configuration as Record<string, unknown>[])[0].actions as Record<string, unknown>[];
  const withAction = (index: number, patch: Record<string, unknown>) => ({
    ...manifest,
    configuration: [
      {
        ...(manifest.configuration as Record<string, unknown>[])[0],
        actions: actions.map((action, i) => (i === index ? { ...action, ...patch } : action)),
      },
    ],
  });
  const rejectConfirm = (confirm: unknown) =>
    validateManifest(withAction(1, { confirm })).valid;
  assert.equal(rejectConfirm(''), false);
  assert.equal(rejectConfirm('x'.repeat(201)), false);
  assert.equal(rejectConfirm('x'.repeat(200)), true);
  assert.equal(rejectConfirm(undefined), true);

  const rejectRender = (render: unknown) =>
    validateManifest(withAction(1, { render })).valid;
  assert.equal(rejectRender('rows'), false);
  assert.equal(rejectRender('button'), true);
});

test('beta.24 admits runtime.dataDirectory with the single-segment grammar', () => {
  const admit = (dataDirectory: unknown) =>
    validateManifest(baseManifest({ runtime: { transport: 'builtin', dataDirectory } })).valid;

  assert.equal(admit('personal-chrome-host'), true);
  assert.equal(admit('a'.repeat(64)), true);
  assert.equal(admit('a'.repeat(65)), false);
  assert.equal(admit('.'), false);
  assert.equal(admit('..'), false);
  assert.equal(admit('Upper'), false);
  assert.equal(admit('-lead'), false);
  assert.equal(admit('has/slash'), false);
  assert.equal(admit(''), false);
});

test('beta.24 admits the new capabilities and the cloud-conversation-host contribution', () => {
  const manifest = baseManifest({
    contributions: [
      {
        type: 'cloud-conversation-host',
        id: 'chatgpt-pro-host',
        provider: 'chatgpt',
        appendMessage: { method: 'appendMessage' },
        assistantReturns: { list: { method: 'listReturns' }, ack: { method: 'ackReturn' } },
      },
    ],
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [{ type: 'cloud-conversation-host', id: 'chatgpt-pro-host' }],
        capabilities: ['cloud.conversation.host', 'data.directory'],
      },
    ],
  });
  assert.equal(validateManifest(manifest).valid, true);

  const withoutCapability = baseManifest({
    ...manifest,
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [{ type: 'cloud-conversation-host', id: 'chatgpt-pro-host' }],
        capabilities: ['plugin.config.read'],
      },
    ],
  });
  const missingCapability = validateManifest(withoutCapability);
  assert.equal(missingCapability.valid, false);
  if (!missingCapability.valid) {
    assert.ok(missingCapability.errors.some((error) => error.keyword === 'capabilityRequired'));
  }

  const wrongProvider = baseManifest({
    ...manifest,
    contributions: [
      { ...(manifest.contributions as Record<string, unknown>[])[0], provider: 'claude' },
    ],
  });
  assert.equal(validateManifest(wrongProvider).valid, false);

  const unknownCapability = baseManifest({
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        capabilities: ['cloud.conversation.hosts'],
      },
    ],
  });
  assert.equal(validateManifest(unknownCapability).valid, false);
});

test('beta.24 cloud-conversation-host requires a runtime', () => {
  const manifest = baseManifest({
    runtime: undefined,
    contributions: [
      {
        type: 'cloud-conversation-host',
        id: 'chatgpt-pro-host',
        provider: 'chatgpt',
        appendMessage: { method: 'appendMessage' },
        assistantReturns: { list: { method: 'listReturns' }, ack: { method: 'ackReturn' } },
      },
    ],
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [{ type: 'cloud-conversation-host', id: 'chatgpt-pro-host' }],
        capabilities: ['cloud.conversation.host'],
      },
    ],
  });
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((error) => error.keyword === 'runtimeRequired'));
  }
});
