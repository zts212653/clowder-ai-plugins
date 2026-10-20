import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

test('manifest declares an executable operator entry and retained private state', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.contributions[0].runtime.entrypoint, 'dist/mcp-entrypoint.mjs');
  assert.deepEqual(manifest.features[0].capabilities, ['plugin.config.read']);
  assert.ok(manifest.data.every((item) => item.strategy === 'retained'));
  assert.equal(manifest.configuration[0].key, 'configurationFile');
  assert.equal(pkg.private, undefined);
  assert.ok(pkg.files.includes('npm-shrinkwrap.json'));
});
