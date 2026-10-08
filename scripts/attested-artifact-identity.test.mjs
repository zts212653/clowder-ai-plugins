import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertAttestedArtifactIdentity,
  validateAttestedArtifactRegistry,
  verifyAttestedArtifactIdentities,
} from './attested-artifact-identity.mjs';

const registry = JSON.parse(
  await readFile(new URL('./attested-artifact-identities.json', import.meta.url), 'utf8'),
);

test('attested artifact registry closes known contract and SDK identities', () => {
  const artifacts = validateAttestedArtifactRegistry(registry);
  assert.deepEqual(
    artifacts.map(entry => `${entry.package}@${entry.version}`),
    [
      '@clowder-ai/plugin-contract@0.1.0-beta.24',
      '@clowder-ai/plugin-contract@0.1.0-beta.25',
      '@clowder-ai/plugin-contract@0.1.0-beta.26',
      '@clowder-ai/plugin-sdk@0.2.0-beta.7',
      '@clowder-ai/plugin-sdk@0.2.0-beta.8',
      '@clowder-ai/plugin-sdk@0.2.0-beta.9',
      '@clowder-ai/plugin-sdk@0.2.0-beta.10',
    ],
  );
});

test('an attested version cannot silently claim different bytes', () => {
  assert.throws(
    () => assertAttestedArtifactIdentity({
      name: '@clowder-ai/plugin-contract',
      version: '0.1.0-beta.25',
      sha256: 'f'.repeat(64),
      size: 222009,
    }, registry.artifacts),
    /version 0\.1\.0-beta\.25 was attested as 80816b01.+bump the version/u,
  );
});

test('the guard packs every governed package even when its current version is new', async () => {
  const packed = [];
  const results = await verifyAttestedArtifactIdentities({
    registry,
    async pack(packageDirectory) {
      packed.push(packageDirectory);
      return packageDirectory === 'packages/plugin-contract'
        ? {
            name: '@clowder-ai/plugin-contract',
            version: '0.1.0-beta.27',
            sha256: 'a'.repeat(64),
            size: 1,
          }
        : {
            name: '@clowder-ai/plugin-sdk',
            version: '0.2.0-beta.11',
            sha256: 'b'.repeat(64),
            size: 1,
          };
    },
  });
  assert.deepEqual(packed, ['packages/plugin-contract', 'packages/plugin-sdk']);
  assert.deepEqual(results.map(result => result.status), ['unattested', 'unattested']);
});
