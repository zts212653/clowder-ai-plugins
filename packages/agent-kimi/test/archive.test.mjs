import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

test('the local candidate passes prepack and ships only its declared runtime closure', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const [artifact] = JSON.parse(execSync('npm pack --dry-run --json', { cwd, encoding: 'utf8' }));
  assert.equal(artifact.name, manifest.name);
  assert.equal(artifact.version, manifest.version);
  assert.deepEqual(artifact.files.map(({ path }) => path).sort(), [
    'README.en.md',
    'README.md',
    'agent-adapter.json',
    'package.json',
    'plugin.yaml',
    'src/index.mjs',
    'src/kimi-events.mjs',
    'src/kimi-launch.mjs',
    'src/kimi-quota.mjs',
  ]);
});
