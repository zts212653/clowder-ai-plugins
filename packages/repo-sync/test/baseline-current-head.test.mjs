import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { safeError } from '../src/execution.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

test('takeover keeps the historical upstream baseline but uses current internal HEAD with declared custom files', async () => {
  const f = await repositories();
  await writeFile(join(f.review, 'README.internal.md'), 'internal customization');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'internal documentation after initial import']);
  await git(f.review, ['push', 'origin', 'main']);
  const current = await git(f.review, ['rev-parse', 'HEAD']);
  const receiver = new Receiver({ ...f.config, internalPaths: ['README.internal.md'] });
  await assert.rejects(
    () => receiver.adopt(f.u0, f.i0),
    (error) => {
      assert.equal(error.code, 'STALE_INTERNAL_HEAD');
      assert.equal(safeError(error).details?.fields?.[0]?.field, 'internal');
      return true;
    },
  );
  assert.equal(await receiver.status(), null);
  await receiver.adopt(f.u0, current);
  assert.deepEqual((await receiver.status()).accepted, { upstream: f.u0, internal: current });
  await receiver.setQueue(f.plans.map((plan) => ({ ...plan, issues: [] })));
  await receiver.start();
  await receiver.prepare();
  const candidate = (await receiver.status()).active.candidate;
  assert.equal(
    await git(receiver.git.directory, ['show', `${candidate}:README.internal.md`]),
    'internal customization',
  );
  assert.equal(await git(receiver.git.directory, ['show', `${candidate}:core.txt`]), 'first');
  assert.equal(await git(f.review, ['rev-parse', 'HEAD']), current);
});
