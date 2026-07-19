import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessCleanupError,
  HarnessTimeoutError,
  MAX_HARNESS_QUEUED_FRAMES,
  runHarnessCase,
  spawnHarnessChild,
  spawnHarnessChildWithAdapter,
  type HarnessPlatformAdapter,
} from './child-process-harness.js';
import { MAX_NDJSON_FRAME_BYTES, NdjsonFrameError } from './ndjson-frame.js';

const echoScript = `
process.stdin.once('data', (chunk) => {
  process.stdout.write(chunk);
});
`;

const idleScript = `
process.stdin.resume();
setInterval(() => {}, 1_000);
`;

const inheritedPipeHelperPrelude = `
const { spawn } = require('node:child_process');
const helper = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);
process.stdout.write(JSON.stringify({ helperPid: helper.pid }) + '\\n');
`;

const inheritedPipeHelperScript = `${inheritedPipeHelperPrelude}
setInterval(() => {}, 1_000);
`;

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

function killForTestCleanup(pid: number | undefined): void {
  if (pid !== undefined && processIsAlive(pid)) {
    process.kill(pid, 'SIGKILL');
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return !processIsAlive(pid);
}

test('exchanges a raw schema-neutral NDJSON frame with a child process', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', echoScript],
  });

  try {
    await child.send({ type: 'ping', payload: { sequence: 1 } });
    assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
      type: 'ping',
      payload: { sequence: 1 },
    });
  } finally {
    await child.stop();
  }
});

test('drains the final stdout frame after the direct child has exited', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', `process.stdout.write('{"type":"final"}\\n');`],
  });

  await child.waitForExit();
  assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
    type: 'final',
  });
  await child.stop();
});

test('Windows cleanup retains a stable sentinel root after target exit', async () => {
  const adapter: HarnessPlatformAdapter = {
    platform: 'win32',
    createProcessTreeRuntime: (signalTarget) => ({
      platform: 'win32',
      now: Date.now,
      sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      signalTarget,
      signalTree: () => assert.fail('Windows cleanup must not signal a POSIX group'),
      treeIsAlive: processIsAlive,
      runTaskkill: async (rootPid) => {
        process.kill(rootPid, 'SIGKILL');
        return { status: 'success' };
      },
    }),
  };
  const child = spawnHarnessChildWithAdapter(
    { command: process.execPath, args: ['-e', 'process.exit(19)'] },
    adapter,
  );
  const rootPid = child.pid;
  assert.notEqual(rootPid, undefined);

  try {
    assert.deepEqual(await child.waitForExit(), { code: 19, signal: null });
    assert.equal(processIsAlive(rootPid as number), true);
    await child.stop(20);
    assert.equal(processIsAlive(rootPid as number), false);
  } finally {
    killForTestCleanup(rootPid);
  }
});

test('Windows cleanup exposes taskkill failure instead of returning silently', async () => {
  let now = 0;
  const taskkillPids: number[] = [];
  const adapter: HarnessPlatformAdapter = {
    platform: 'win32',
    createProcessTreeRuntime: (signalTarget) => ({
      platform: 'win32',
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      signalTarget,
      signalTree: () => assert.fail('Windows cleanup must not signal a POSIX group'),
      treeIsAlive: () => true,
      runTaskkill: async (rootPid) => {
        taskkillPids.push(rootPid);
        return { status: 'nonzero', code: 128 };
      },
    }),
  };
  const child = spawnHarnessChildWithAdapter(
    { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    adapter,
  );
  const rootPid = child.pid;
  assert.notEqual(rootPid, undefined);

  try {
    await child.waitForExit();
    await assert.rejects(
      child.stop(0),
      (error: unknown) =>
        error instanceof HarnessCleanupError &&
        error.rootPid === rootPid &&
        error.message.includes('nonzero'),
    );
    assert.deepEqual(taskkillPids, [rootPid]);
  } finally {
    killForTestCleanup(rootPid);
    if (rootPid !== undefined) {
      await waitForProcessExit(rootPid, 300);
    }
  }
});

test('case timeout kills the isolated child before rejecting', async () => {
  let pid: number | undefined;

  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', idleScript],
        timeoutMs: 30,
      },
      async (child) => {
        pid = child.pid;
        return new Promise<never>(() => {});
      },
    ),
    (error: unknown) => error instanceof HarnessTimeoutError,
  );

  if (pid === undefined) {
    assert.fail('case callback did not expose the child pid');
  }
  const terminatedPid = pid;
  assert.throws(() => process.kill(terminatedPid, 0), { code: 'ESRCH' });
});

test('case timeout kills helpers that inherit the child protocol pipes', async () => {
  let helperPid: number | undefined;
  let safetyTimer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runHarnessCase(
        {
          command: process.execPath,
          args: ['-e', inheritedPipeHelperScript],
          timeoutMs: 200,
          terminateGraceMs: 40,
        },
        async (child) => {
          const value = (await child.receive({ timeoutMs: 1_000 })).value;
          assert.equal(typeof value.helperPid, 'number');
          helperPid = value.helperPid as number;
          safetyTimer = setTimeout(() => killForTestCleanup(helperPid), 1_000);
          return new Promise<never>(() => {});
        },
      ),
      (error: unknown) => error instanceof HarnessTimeoutError,
    );
    assert.notEqual(helperPid, undefined);
    assert.equal(await waitForProcessExit(helperPid as number, 300), true);
    assert.ok(Date.now() - startedAt < 700, 'timeout cleanup waited for the leaked helper');
  } finally {
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
    }
    killForTestCleanup(helperPid);
  }
});

test('SIGKILL of one case does not prevent a subsequent child case', async () => {
  const killed = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', idleScript],
  });
  killed.kill('SIGKILL');
  assert.deepEqual(await killed.waitForExit(), {
    code: null,
    signal: 'SIGKILL',
  });

  const replacement = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', echoScript],
  });
  try {
    await replacement.send({ type: 'replacement' });
    assert.deepEqual((await replacement.receive({ timeoutMs: 1_000 })).value, {
      type: 'replacement',
    });
  } finally {
    await replacement.stop();
  }
});

test('oversized stdout fails closed and kills the offending child', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write('x'.repeat(${MAX_NDJSON_FRAME_BYTES + 1})); setInterval(() => {}, 1_000);`,
    ],
  });

  await assert.rejects(
    child.receive({ timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
  );
  assert.deepEqual(await child.waitForExit(), {
    code: null,
    signal: 'SIGKILL',
  });
});

test('fatal protocol output kills helpers that inherit the child protocol pipes', async () => {
  const script = `${inheritedPipeHelperPrelude}
setTimeout(() => process.stdout.write('x'.repeat(${MAX_NDJSON_FRAME_BYTES + 1})), 20);
`;
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', script],
  });
  let helperPid: number | undefined;
  let safetyTimer: NodeJS.Timeout | undefined;

  try {
    const value = (await child.receive({ timeoutMs: 1_000 })).value;
    assert.equal(typeof value.helperPid, 'number');
    helperPid = value.helperPid as number;
    safetyTimer = setTimeout(() => killForTestCleanup(helperPid), 1_000);
    const startedAt = Date.now();

    await assert.rejects(
      child.receive({ timeoutMs: 1_000 }),
      (error: unknown) =>
        error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
    );
    await child.waitForExit();

    assert.equal(await waitForProcessExit(helperPid, 200), true);
    assert.ok(Date.now() - startedAt < 500, 'fatal cleanup waited for the leaked helper');
  } finally {
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
    }
    killForTestCleanup(helperPid);
  }
});

test('reports spawn failure through the harness instead of an unhandled child error', async () => {
  const child = spawnHarnessChild({
    command: '/definitely/missing/clowder-plugin',
  });

  await assert.rejects(
    child.receive({ timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
  await child.waitForExit();
});

test('drains protocol diagnostics from stderr without blocking stdout', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: [
      '-e',
      `process.stderr.write('x'.repeat(2 * 1024 * 1024)); process.stdin.once('data', chunk => process.stdout.write(chunk));`,
    ],
  });

  try {
    await child.send({ type: 'after-diagnostics' });
    assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
      type: 'after-diagnostics',
    });
  } finally {
    await child.stop();
  }
});

test('rejects a large send when the child closes stdin without crashing the harness', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').closeSync(0); process.stdout.write('{"type":"stdin-closed"}\\n'); setInterval(() => {}, 1_000);`,
    ],
  });

  try {
    assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
      type: 'stdin-closed',
    });
    await assert.rejects(child.send({ payload: 'x'.repeat(512 * 1024) }), {
      code: 'EPIPE',
    });
  } finally {
    await child.stop();
  }
});

test('fails closed when decoded stdout frames exceed the bounded backlog', async () => {
  const burst = Array.from(
    { length: MAX_HARNESS_QUEUED_FRAMES + 1 },
    (_, sequence) => `${JSON.stringify({ sequence })}\n`,
  ).join('');
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(burst)});`],
  });

  await child.waitForExit();
  await assert.rejects(
    child.receive({ timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof Error && error.name === 'HarnessFrameBacklogError',
  );
});
