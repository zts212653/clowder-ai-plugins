import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { objectUrl, validateConfig } from '../src/config.mjs';

const configuration = {
  sourceUrl: 'https://github.com/demo/core.git',
  internalUrl: 'git@codehub.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  stateDir: resolve('.cat-cafe/tmp/private-config-test'),
};
test('credentials, non-Git URLs, unsafe refs and truthy capability flags are rejected', () => {
  for (const sourceUrl of [
    'https://user:secret@github.com/demo/core',
    'https://github.com/demo/core?token=secret',
    'javascript:alert(1)',
  ])
    assert.throws(() => validateConfig({ ...configuration, sourceUrl }), { code: 'INVALID_URL' });
  assert.throws(() => validateConfig({ ...configuration, targetBranch: 'main..other' }), { code: 'INVALID_BRANCH' });
  assert.throws(() => validateConfig({ ...configuration, commitClosureVerified: 'false' }), {
    code: 'INVALID_CAPABILITY',
  });
  assert.throws(() => objectUrl('https://codehub.example/core/pull/1?access_token=secret'), { code: 'INVALID_URL' });
});
test('state is separate from local core repositories and source cannot equal destination', () => {
  const sourceUrl = resolve('.cat-cafe/tmp/source-test');
  assert.throws(
    () => validateConfig({ ...configuration, allowLocal: true, sourceUrl, stateDir: resolve(sourceUrl, 'private') }),
    { code: 'STATE_INSIDE_CORE' },
  );
  assert.throws(() => validateConfig({ ...configuration, internalUrl: configuration.sourceUrl }), {
    code: 'SAME_REPOSITORY',
  });
});
