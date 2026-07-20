import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnWindowsSentinel } from './windows-sentinel.js';

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

test('keeps a stable wrapper root alive after the direct target exits', async () => {
  const sentinel = spawnWindowsSentinel({
    command: process.execPath,
    args: ['-e', 'process.exit(23)'],
  });
  const rootPid = sentinel.root.pid;
  assert.notEqual(rootPid, undefined);

  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        sentinel.onTargetExit((code, signal) => resolve({ code, signal }));
      },
    );

    assert.deepEqual(exit, { code: 23, signal: null });
    assert.equal(processIsAlive(rootPid as number), true);
  } finally {
    if (processIsAlive(rootPid as number)) {
      sentinel.root.kill('SIGKILL');
      await new Promise<void>((resolve) => sentinel.root.once('close', () => resolve()));
    }
  }
});
