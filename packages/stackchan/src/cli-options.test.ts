import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStackChanConfigPath } from './cli-options.js';

test('resolves one absolute --config argument or the environment fallback', () => {
  assert.equal(
    resolveStackChanConfigPath(['--config', '/tmp/stackchan.json'], {}),
    '/tmp/stackchan.json',
  );
  assert.equal(
    resolveStackChanConfigPath([], {
      STACKCHAN_ADAPTER_CONFIG: '/tmp/from-env.json',
    }),
    '/tmp/from-env.json',
  );
});

test('rejects missing, relative, duplicate, and unknown CLI configuration', () => {
  assert.throws(() => resolveStackChanConfigPath([], {}), /required/i);
  assert.throws(
    () => resolveStackChanConfigPath(['--config', 'relative.json'], {}),
    /absolute/i,
  );
  assert.throws(
    () =>
      resolveStackChanConfigPath(
        ['--config', '/tmp/a.json', '--config', '/tmp/b.json'],
        {},
      ),
    /exactly/i,
  );
  assert.throws(
    () => resolveStackChanConfigPath(['--token', 'secret'], {}),
    /exactly/i,
  );
});
