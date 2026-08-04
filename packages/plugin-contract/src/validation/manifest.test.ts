import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateManifest } from './manifest.js';

const fixturesRoot = new URL('../../fixtures/manifest/', import.meta.url);

async function readFixtures(
  validity: 'valid' | 'invalid',
): Promise<readonly [string, unknown][]> {
  const directory = new URL(`${validity}/`, fixturesRoot);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return Promise.all(
    names.map(async (name) => [
      name,
      JSON.parse(await readFile(new URL(name, directory), 'utf8')) as unknown,
    ] as const),
  );
}

test('validates the complete manifest fixture matrix through the public runtime API', async () => {
  for (const [name, fixture] of await readFixtures('valid')) {
    const result = validateManifest(fixture);
    assert.equal(result.valid, true, `${name} should validate`);
    if (result.valid) {
      assert.equal(result.manifest, fixture);
      assert.deepEqual(result.errors, []);
    }
  }

  for (const [name, fixture] of await readFixtures('invalid')) {
    const result = validateManifest(fixture);
    assert.equal(result.valid, false, `${name} should fail validation`);
    if (!result.valid) {
      assert.ok(result.errors.length > 0, `${name} should include a validation error`);
      assert.ok(
        result.errors.every(
          (error) =>
            typeof error.instancePath === 'string' &&
            error.schemaPath.length > 0 &&
            error.keyword.length > 0 &&
            error.message.length > 0 &&
            Object.keys(error).sort().join(',') ===
              'instancePath,keyword,message,schemaPath',
        ),
      );
    }
  }
});

test('fails closed for values outside the manifest object domain', () => {
  for (const value of [null, [], 'manifest']) {
    const result = validateManifest(value);
    assert.equal(result.valid, false);
    if (!result.valid) assert.ok(result.errors.length > 0);
  }
});

test('returns the original caller-owned data only after full validation', () => {
  const manifest = {
    pluginId: 'example.plugin',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Example plugin',
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        capabilities: ['plugin.config.read'],
      },
    ],
    runtime: { transport: 'stdio', entrypoint: 'dist/index.js' },
  };

  const result = validateManifest(manifest);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.manifest, manifest);
  }
});
