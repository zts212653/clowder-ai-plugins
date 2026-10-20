import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { discover } from '../src/github.mjs';
import { writePrivate } from '../src/private-config.mjs';
import { saveTransferState } from '../src/transfer-state.mjs';

const execute = promisify(execFile);
for (const status of ['IMPORTED', 'EXPORTED']) {
  test(`CLI and direct discovery cannot write through a ${status} migration gate`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-sync-transfer-cli-'));
    const receiver = new Receiver({
      mode: 'continuous',
      sourceUrl: 'https://github.com/demo/core.git',
      internalUrl: 'git@internal.invalid:core.git',
      sourceBranch: 'main',
      targetBranch: 'main',
      stateDir: join(root, 'state'),
    });
    await mkdir(receiver.config.stateDir);
    await saveTransferState(receiver.config, { packageId: 'a'.repeat(64), kind: 'migration', status });
    const file = join(root, 'config.json');
    await writePrivate(file, receiver.config);
    const original = await readFile(join(receiver.config.stateDir, 'transfer.json'), 'utf8');
    for (const action of ['prepare', 'start', 'create-pr', 'recover', 'discover']) {
      await assert.rejects(
        execute(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), action, file], {
          windowsHide: true,
          timeout: 20000,
        }),
        (error) => error.code === 1 && error.stderr.includes('TRANSFER_ACTIVATION_REQUIRED'),
      );
    }
    let remoteReads = 0;
    await assert.rejects(
      discover(
        receiver,
        { kind: 'latest' },
        {
          api: () => {
            remoteReads++;
          },
        },
      ),
      { code: 'TRANSFER_ACTIVATION_REQUIRED' },
    );
    assert.equal(remoteReads, 0);
    assert.equal(await readFile(join(receiver.config.stateDir, 'transfer.json'), 'utf8'), original);
  });
}
