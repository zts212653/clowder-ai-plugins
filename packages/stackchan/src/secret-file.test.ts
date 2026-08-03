import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSecretFile, writeSecretFile } from './secret-file.js';

test('persists opaque credentials atomically with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-secret-'));
  const path = join(directory, 'nested', 'limb-api-key');

  assert.equal(await readSecretFile(path, { required: false }), undefined);
  await writeSecretFile(path, 'api-key-0123456789');

  assert.equal(await readSecretFile(path, { required: true }), 'api-key-0123456789');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), 'api-key-0123456789\n');
});

test('rejects group-readable and multiline secret files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-secret-'));
  const path = join(directory, 'token');

  await writeFile(path, '0123456789abcdef\n', { mode: 0o644 });
  await assert.rejects(
    readSecretFile(path, { required: true }),
    /owner-only permissions/i,
  );

  await writeFile(path, '0123456789abcdef\nsecond-line\n', { mode: 0o600 });
  await chmod(path, 0o600);
  await assert.rejects(readSecretFile(path, { required: true }), /single line/i);
});
