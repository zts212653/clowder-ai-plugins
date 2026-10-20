import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLUGIN_WEBHOOK_DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  PLUGIN_WEBHOOK_MAX_REQUEST_BODY_LIMIT_BYTES,
  validateManifest,
} from '../index.js';

const base = {
  pluginId: 'test.webhook-body-limit',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'Webhook body limit',
  features: [
    {
      id: 'webhook',
      name: 'Webhook',
      resources: [],
      contributions: [{ type: 'webhook', id: 'mcp' }],
      capabilities: [],
    },
  ],
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
} as const;

test('webhook body budgets opt in within the public fixed cap', () => {
  const webhook = { type: 'webhook', id: 'mcp', path: 'mcp', methods: ['POST'] } as const;
  const manifest = { ...base, contributions: [webhook] };
  assert.equal(validateManifest(manifest).valid, true);
  for (const requestBodyLimitBytes of [1, 1_048_576, 15 * 1_024 * 1_024]) {
    assert.equal(validateManifest({ ...manifest, contributions: [{ ...webhook, requestBodyLimitBytes }] }).valid, true);
  }
  for (const requestBodyLimitBytes of [0, -1, 1.5, 15 * 1_024 * 1_024 + 1, Number.MAX_SAFE_INTEGER, '15728640']) {
    assert.equal(
      validateManifest({ ...manifest, contributions: [{ ...webhook, requestBodyLimitBytes }] }).valid,
      false,
      String(requestBodyLimitBytes),
    );
  }
});

test('public webhook budgets are generated from the schema', () => {
  assert.equal(PLUGIN_WEBHOOK_DEFAULT_REQUEST_BODY_LIMIT_BYTES, 1_048_576);
  assert.equal(PLUGIN_WEBHOOK_MAX_REQUEST_BODY_LIMIT_BYTES, 15_728_640);
});
