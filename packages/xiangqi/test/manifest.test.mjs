import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

test('manifest declares only the executable pure MCP feature and retains game data', () => {
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const validated = validateManifest(manifest);
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.runtime.transport, 'builtin');
  assert.deepEqual(manifest.features.map((feature) => feature.id), ['analyze-position']);
  assert.deepEqual(manifest.features[0].capabilities, []);
  assert.deepEqual(manifest.data.map((item) => item.strategy), ['retained', 'retained']);
  assert.equal(manifest.contributions[0].runtime.entrypoint, 'dist/mcp-entrypoint.mjs');
});
