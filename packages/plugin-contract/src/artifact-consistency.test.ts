import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const pluginContractDir = fileURLToPath(new URL('..', import.meta.url));

function sha512Of(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

test('connector-feishu shrinkwrap pins the exact official-publish packed contract artifact', async () => {
  const shrinkwrap = JSON.parse(
    readFileSync(`${pluginContractDir}/../connector-feishu/npm-shrinkwrap.json`, 'utf8'),
  ) as {
    packages: Record<string, { version?: string; integrity?: string; resolved?: string }>;
  };
  const entry = shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract'];
  assert.ok(entry?.version);
  const current = JSON.parse(readFileSync(`${pluginContractDir}/package.json`, 'utf8'));
  if (entry.version !== current.version) {
    // The immutable consumer may pin a newer published baseline than local caches.
    // Fetch precisely its locked registry URL instead of assuming an ignored tarball exists.
    assert.ok(entry.resolved);
    assert.equal(new URL(entry.resolved).origin, 'https://registry.npmjs.org');
    const response = await fetch(entry.resolved, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const published = Buffer.from(await response.arrayBuffer());
    assert.ok(published.length <= 16 * 1024 * 1024);
    assert.equal(sha512Of(published), entry.integrity);
    return;
  }
  assert.ok(entry?.integrity?.startsWith('sha512-'), 'shrinkwrap entry must pin a sha512 integrity');

  const destination = mkdtempSync(join(tmpdir(), 'clowder-artifact-consistency-'));
  try {
    // Standalone tests must not depend on ci-gate having built ignored dist/.
    // Use the package's real build before the official --ignore-scripts pack.
    const build = spawnSync('pnpm', ['build'], {
      cwd: pluginContractDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(build.status, 0, [build.stdout, build.stderr].filter(Boolean).join('\n'));
    const result = spawnSync(
      process.execPath,
      ['scripts/pack-publish-artifact.mjs', 'packages/plugin-contract', destination],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(
      result.status,
      0,
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
    const [artifact] = JSON.parse(result.stdout) as [
      { filename: string; integrity: string },
    ];
    assert.equal(
      entry.integrity,
      artifact.integrity,
      'shrinkwrap must pin the official pack-publish-artifact.mjs output',
    );

  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
