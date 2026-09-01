import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

test('plugin.yaml is the static access protocol and matches the package version', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, result.valid ? undefined : JSON.stringify(result.errors));
  if (!result.valid) return;

  assert.equal(result.manifest.version, packageJson.version);
  assert.equal(result.manifest.contractVersion, '0.1.0-beta.13');
  assert.deepEqual(result.manifest.features[0]?.contributions, [
    { type: 'mcp', id: 'video-analysis-toolset' },
  ]);
});
