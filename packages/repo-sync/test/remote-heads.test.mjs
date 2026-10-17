import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { repositories } from './fixtures.mjs';

test('real advertised heads require no object download; inaccessible internal prevents all downloads', async () => {
  const f = await repositories();
  const stateDir = join(await mkdtemp(join(tmpdir(), 'repo-sync-heads-')), 'state');
  const receiver = new Receiver({ ...f.config, stateDir });
  assert.deepEqual(await receiver.git.heads(), { upstream: f.u2, internal: f.i0 });
  await assert.rejects(access(receiver.git.directory), { code: 'ENOENT' });
  const invalid = new Receiver({ ...f.config, stateDir, internalUrl: join(f.root, 'missing.git') });
  await assert.rejects(invalid.git.fetch(), { code: 'REPOSITORY_UNAVAILABLE' });
  await assert.rejects(access(invalid.git.directory), { code: 'ENOENT' });
  const missing = new Receiver({ ...f.config, stateDir, targetBranch: 'missing-branch' });
  await assert.rejects(missing.git.heads(), { code: 'REMOTE_BRANCH_MISSING' });
});
