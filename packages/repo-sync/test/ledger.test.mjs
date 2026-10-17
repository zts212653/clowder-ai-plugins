import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';

test('valid JSON with a missing acceptance cursor is rejected without overwriting the ledger', async () => {
  const temporary = join(process.cwd(), '.cat-cafe', 'tmp');
  await mkdir(temporary, { recursive: true });
  const stateDir = await mkdtemp(join(temporary, 'repo-sync-ledger-'));
  const receiver = new Receiver({
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@codehub.example:core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir,
  });
  const broken = { schema: 1, bindingId: receiver.config.bindingId, deliveries: [] };
  await receiver.store.save(broken);
  await assert.rejects(() => receiver.read(), { code: 'LEDGER_INVALID' });
  assert.deepEqual(await receiver.store.read(), broken);
});
