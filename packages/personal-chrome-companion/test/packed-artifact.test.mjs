import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const packageDirectory = new URL('../', import.meta.url);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('packs only the public companion closure and exposes a non-installing helper CLI', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'f247-companion-pack-'));
  try {
    const output = run(
      'node',
      ['scripts/pack-publish-artifact.mjs', 'packages/personal-chrome-companion', temporary],
      new URL('../../', packageDirectory),
    );
    const [artifact] = JSON.parse(output);
    const archive = join(temporary, artifact.filename);
    const listing = run('tar', ['-tzf', archive], temporary).split('\n');
    for (const member of [
      'package/dist/index.js',
      'package/extension/manifest.json',
      'package/native-host/native-host-cli.mjs',
      'package/README.md',
    ]) {
      assert.ok(listing.includes(member), `${member} is missing from packed artifact`);
    }
    assert.ok(listing.every(member => !member.includes('install-host')));
    const packageJson = JSON.parse(await readFile(new URL('package.json', packageDirectory), 'utf8'));
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.bin['clowder-personal-chrome-host'], 'native-host/native-host-cli.mjs');
    assert.equal(run('node', [new URL('native-host/native-host-cli.mjs', packageDirectory).pathname, '--help'], packageDirectory).includes('Host-supplied configuration'), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
