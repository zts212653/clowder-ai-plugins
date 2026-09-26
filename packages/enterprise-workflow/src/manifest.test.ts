import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

test('manifest exposes only the governed direct-tool and skill surface', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const validated = validateManifest(manifest);
  assert.equal(validated.valid, true, validated.valid ? undefined : JSON.stringify(validated.errors));
  if (!validated.valid) return;

  assert.equal(validated.manifest.pluginId, 'official.enterprise-workflow');
  assert.deepEqual(validated.manifest.configuration?.map(({ key, kind, required, default: value }) => ({
    key,
    kind,
    required,
    default: value,
  })), [
    { key: 'wecomCliPath', kind: 'string', required: true, default: 'wecom-cli' },
    { key: 'larkCliPath', kind: 'string', required: true, default: 'lark-cli' },
  ]);
  assert.deepEqual(validated.manifest.contributions?.map(({ type, id }) => ({ type, id })), [
    { type: 'tool', id: 'wecom-actions' },
    { type: 'tool', id: 'lark-actions' },
    { type: 'skill', id: 'enterprise-workflow-skill' },
  ]);
  const tools = validated.manifest.contributions?.filter((item) => item.type === 'tool') ?? [];
  assert.deepEqual(tools.map(({ name, action }) => ({ name, action })), [
    { name: 'wecom_action', action: { method: 'wecom.action' } },
    { name: 'lark_action', action: { method: 'lark.action' } },
  ]);
  for (const tool of tools) {
    const encoded = JSON.stringify(tool.inputSchema);
    assert.doesNotMatch(encoded, /invocationId|callbackToken/u);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.oneOf));
  }
  assert.deepEqual(validated.manifest.features[0]?.capabilities, ['plugin.config.read']);
  assert.deepEqual(validated.manifest.runtime, {
    transport: 'builtin',
    entrypoint: 'dist/plugin-entrypoint.js',
  });
});
