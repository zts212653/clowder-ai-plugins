import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { Receiver } from '../src/engine.mjs';
import { configure, configuredReceiver } from '../src/settings.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const config = {
  sourceUrl: 'https://github.com/demo/core.git',
  internalUrl: 'git@codehub.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  stateDir: resolve('.cat-cafe/tmp/version-policy'),
  mode: 'version',
};
test('version policy: path traversal, wildcard, Git internals and overlaps are rejected; mode binds the policy', () => {
  for (const path of ['../secret', '/absolute', 'C:/secret', '.git/config', 'docs/**', 'docs//a', 'docs/./a', 'a\\b'])
    assert.throws(() => validateConfig({ ...config, internalPaths: [path] }), { code: 'INVALID_POLICY' });
  assert.throws(() => validateConfig({ ...config, internalPaths: ['docs/', 'docs/a.md'] }), {
    code: 'INVALID_POLICY',
  });
  assert.throws(() => validateConfig({ ...config, mergePaths: ['docs/'] }), { code: 'UNSUPPORTED_MERGE_POLICY' });
  assert.notEqual(
    validateConfig(config).bindingId,
    validateConfig({ ...config, internalPaths: ['internal/'] }).bindingId,
  );
  assert.notEqual(validateConfig(config).bindingId, validateConfig({ ...config, mode: 'continuous' }).bindingId);
});
test('version settings: mode choice survives restart; adopted policy cannot be switched or silently changed', async () => {
  const f = await versionRepositories();
  const initial = new Receiver({ ...f.config, mode: 'continuous', internalPaths: [], mergePaths: [] });
  await configure(initial, f.config);
  const receiver = await configuredReceiver({
    ...f.config,
    mode: undefined,
    internalPaths: undefined,
    mergePaths: undefined,
  });
  assert.equal(receiver.config.mode, 'version');
  await receiver.adopt(f.u0, f.i0);
  await assert.rejects(() => configure(receiver, { mode: 'continuous' }), { code: 'ALREADY_ADOPTED' });
  await assert.rejects(() => configuredReceiver({ ...f.config, internalPaths: [] }), { code: 'MODE_CONFLICT' });
  await assert.rejects(() => new Receiver({ ...f.config, internalPaths: ['internal-docs/', 'OWNED.md'] }).read(), {
    code: 'BINDING_CONFLICT',
  });
});
