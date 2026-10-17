import assert from 'node:assert/strict';
import test from 'node:test';

// These cases spawn real child processes; under CPU contention a missed
// deadline must fail the test, not wedge the whole runner.
const TEST_TIMEOUT_MS = 30_000;
const boundedTest = (name: string, fn: () => unknown) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn as () => void | Promise<void>);

import {
  HarnessCleanupError,
  HarnessFrameBacklogError,
  HarnessTimeoutError,
  MAX_HARNESS_QUEUED_FRAMES,
  MAX_TIMER_MS,
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

// Helpers that leak past cleanup must outlive the assertions by a wide
// margin: the tests assert cleanup finishes well inside this lifetime
// instead of racing absolute wall-clock numbers that CPU contention
// inflates on shared runners.
const LEAKED_HELPER_LIFETIME_MS = 10_000;

const inheritedPipeHelperPrelude = `
const { spawn } = require('node:child_process');
const helper = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), ${LEAKED_HELPER_LIFETIME_MS}); setInterval(() => {}, 1_000);"],
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

boundedTest('exchanges a raw schema-neutral NDJSON frame with a child process', async () => {
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

boundedTest('drains the final stdout frame after the direct child has exited', async () => {
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

boundedTest('Windows cleanup retains a stable sentinel root after target exit', async () => {
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

boundedTest('Windows cleanup exposes taskkill failure instead of returning silently', async () => {
  let now = 0;
  const taskkillPids: number[] = [];
  const adapter: HarnessPlatformAdapter = {
    platform: 'win32',
    createProcessTreeRuntime: (signalTarget) => ({
      platform: 'win32',
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      signalTarget,
      signalTree: () => assert.fail('Windows cleanup must not signal a POSIX group'),
      treeIsAlive: () => false,
      runTaskkill: async (rootPid) => {
        taskkillPids.push(rootPid);
        process.kill(rootPid, 'SIGKILL');
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
      await waitForProcessExit(rootPid, 5_000);
    }
  }
});

boundedTest('case timeout kills the isolated child before rejecting', async () => {
  let pid: number | undefined;

  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', idleScript],
        timeoutMs: 500,
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
  assert.equal(
    await waitForProcessExit(terminatedPid, 5_000),
    true,
    'case timeout must kill the isolated child',
  );
});

boundedTest('case timeout kills helpers that inherit the child protocol pipes', async () => {
  let helperPid: number | undefined;
  let safetyTimer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runHarnessCase(
        {
          command: process.execPath,
          args: ['-e', inheritedPipeHelperScript],
          // Verdict window: the callback must observe helperPid before the
          // case times out. At 200ms a 5x CPU-oversubscribed host left
          // helperPid undefined in 5/6 rounds; 2000ms passes 4/4 at 10x
          // while the cleanup-meaning mutation below still turns red.
          timeoutMs: 2_000,
          terminateGraceMs: 40,
        },
        async (child) => {
          const value = (await child.receive({ timeoutMs: 2_000 })).value;
          assert.equal(typeof value.helperPid, 'number');
          helperPid = value.helperPid as number;
          // Last-resort cleanup must outlive the assertion window, or a
          // broken harness cleanup is masked by this timer firing first.
          safetyTimer = setTimeout(
            () => killForTestCleanup(helperPid),
            LEAKED_HELPER_LIFETIME_MS * 2,
          );
          return new Promise<never>(() => {});
        },
      ),
      (error: unknown) => error instanceof HarnessTimeoutError,
    );
    assert.notEqual(helperPid, undefined);
    assert.equal(await waitForProcessExit(helperPid as number, 5_000), true);
    assert.ok(
      Date.now() - startedAt < LEAKED_HELPER_LIFETIME_MS / 2,
      'timeout cleanup waited for the leaked helper',
    );
  } finally {
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
    }
    killForTestCleanup(helperPid);
  }
});

boundedTest('SIGKILL of one case does not prevent a subsequent child case', async () => {
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

boundedTest('oversized stdout fails closed and kills the offending child', async () => {
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

boundedTest('fatal protocol output kills helpers that inherit the child protocol pipes', async () => {
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
    const value = (await child.receive({ timeoutMs: 2_000 })).value;
    assert.equal(typeof value.helperPid, 'number');
    helperPid = value.helperPid as number;
    // Last-resort cleanup must outlive the assertion window, or a broken
    // harness cleanup is masked by this timer firing first.
    safetyTimer = setTimeout(
      () => killForTestCleanup(helperPid),
      LEAKED_HELPER_LIFETIME_MS * 2,
    );
    const startedAt = Date.now();

    await assert.rejects(
      child.receive({ timeoutMs: 2_000 }),
      (error: unknown) =>
        error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
    );
    await child.waitForExit();

    assert.equal(await waitForProcessExit(helperPid, 5_000), true);
    assert.ok(
      Date.now() - startedAt < LEAKED_HELPER_LIFETIME_MS / 2,
      'fatal cleanup waited for the leaked helper',
    );
  } finally {
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
    }
    killForTestCleanup(helperPid);
  }
});

boundedTest('reports spawn failure through the harness instead of an unhandled child error', async () => {
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

boundedTest('drains protocol diagnostics from stderr without blocking stdout', async () => {
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

boundedTest('rejects a large send when the child closes stdin without crashing the harness', async () => {
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

boundedTest('fails closed when decoded stdout frames exceed the bounded backlog', async () => {
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

boundedTest('runHarnessCase rejects a fatal backlog even when the callback reports success', async () => {
  const burst = Array.from(
    { length: MAX_HARNESS_QUEUED_FRAMES + 1 },
    (_, sequence) => `${JSON.stringify({ sequence })}\n`,
  ).join('');

  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(burst)});`],
        // Wedge bound only: detection is data-driven below, not a race
        // against a wall-clock window.
        timeoutMs: 5_000,
      },
      async (child) => {
        // Once the child has exited, every burst frame has been consumed by
        // the harness; the queued overflow then surfaces deterministically
        // as HarnessFrameBacklogError instead of racing a 100ms sleep.
        await child.waitForExit();
        await assert.rejects(
          child.receive({ timeoutMs: 5_000 }),
          (error: unknown) => error instanceof HarnessFrameBacklogError,
        );
        return 'reported-success';
      },
    ),
    (error: unknown) => error instanceof HarnessFrameBacklogError,
  );
});

boundedTest('runHarnessCase rejects fatal trailing output emitted during teardown', async () => {
  const trailingProtocolFailureScript = `
process.on('SIGTERM', () => {
  process.stdout.write('not-json\\n');
});
process.stdout.write('{"ready":true}\\n');
setInterval(() => {}, 1_000);
`;

  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', trailingProtocolFailureScript],
        timeoutMs: 1_000,
      },
      async (child) => {
        assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
          ready: true,
        });
        return 'reported-success';
      },
    ),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'INVALID_JSON',
  );
});

boundedTest('runHarnessCase surfaces a target spawn error despite a successful callback', async () => {
  await assert.rejects(
    runHarnessCase(
      {
        command: '/definitely/missing/clowder-plugin',
        timeoutMs: 1_000,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'reported-success';
      },
    ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
});

boundedTest('runHarnessCase surfaces a handled stdin stream failure', async () => {
  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').closeSync(0); process.stdout.write('{"ready":true}\\n'); setInterval(() => {}, 1_000);`,
        ],
        timeoutMs: 1_000,
      },
      async (child) => {
        assert.deepEqual((await child.receive({ timeoutMs: 1_000 })).value, {
          ready: true,
        });
        await assert.rejects(child.send({ payload: 'x'.repeat(512 * 1024) }), {
          code: 'EPIPE',
        });
        return 'reported-success';
      },
    ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'EPIPE',
  );
});

boundedTest('runHarnessCase preserves a successful callback across normal teardown', async () => {
  const result = await runHarnessCase(
    {
      command: process.execPath,
      args: ['-e', idleScript],
      timeoutMs: 1_000,
    },
    async () => 'reported-success',
  );

  assert.equal(result, 'reported-success');
});

// ---------------------------------------------------------------------------
// Node timer overflow — values above 2^31-1 are silently clamped to 1ms
// by the Node runtime. These tests prove the guard rejects before setTimeout.
// ---------------------------------------------------------------------------

boundedTest('MAX_TIMER_MS equals 2^31-1', () => {
  assert.equal(MAX_TIMER_MS, 2_147_483_647);
});

boundedTest('receive rejects timeoutMs above Node timer ceiling', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', idleScript],
  });
  try {
    await assert.rejects(
      child.receive({ timeoutMs: MAX_TIMER_MS + 1 }),
      RangeError,
    );
  } finally {
    await child.stop();
  }
});

boundedTest('stop rejects terminateGraceMs above Node timer ceiling', async () => {
  const child = spawnHarnessChild({
    command: process.execPath,
    args: ['-e', idleScript],
  });
  await assert.rejects(
    child.stop(MAX_TIMER_MS + 1),
    RangeError,
  );
  // stop with valid grace to clean up
  await child.stop();
});

boundedTest('runHarnessCase rejects timeoutMs above Node timer ceiling', async () => {
  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', idleScript],
        timeoutMs: MAX_TIMER_MS + 1,
      },
      async () => 'should-not-reach',
    ),
    RangeError,
  );
});

boundedTest('runHarnessCase rejects terminateGraceMs above Node timer ceiling before spawning child', async () => {
  let callbackExecuted = false;
  await assert.rejects(
    runHarnessCase(
      {
        command: process.execPath,
        args: ['-e', idleScript],
        timeoutMs: 5_000,
        terminateGraceMs: MAX_TIMER_MS + 1,
      },
      async () => {
        callbackExecuted = true;
        return 'should-not-reach';
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /terminateGraceMs/);
      return true;
    },
  );
  assert.equal(callbackExecuted, false, 'callback must not execute when terminateGraceMs is invalid');
});
