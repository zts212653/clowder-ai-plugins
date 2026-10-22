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

test('connector-feishu shrinkwrap pins the exact official-publish packed contract artifact', () => {
  const shrinkwrap = JSON.parse(
    readFileSync(`${pluginContractDir}/../connector-feishu/npm-shrinkwrap.json`, 'utf8'),
  ) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const entry = shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract'];
  assert.equal(entry?.version, '0.2.0');
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
    const official = readFileSync(join(destination, artifact.filename));

    assert.equal(
      entry.integrity,
      artifact.integrity,
      'shrinkwrap must pin the official pack-publish-artifact.mjs output',
    );
    const packed = readFileSync(`${pluginContractDir}/clowder-ai-plugin-contract-0.2.0.tgz`);
    assert.equal(
      sha512Of(packed),
      artifact.integrity,
      'committed tgz must be byte-identical to the official publish artifact',
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
