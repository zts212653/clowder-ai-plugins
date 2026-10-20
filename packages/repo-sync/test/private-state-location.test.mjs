import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';

test('a production config outside Git cannot place its private ledger inside the plugin installation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-state-location-'));
  const file = join(folder, 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      sourceUrl: 'https://github.com/example/core.git',
      internalUrl: 'git@codehub.example:team/core.git',
      sourceBranch: 'main',
      targetBranch: 'main',
      stateDir: resolve('web/private-state'),
    }),
  );
  await assert.rejects(() => createConnection(file), { code: 'PRIVATE_STATE_LOCATION' });
});
