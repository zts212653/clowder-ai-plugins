import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessTimeoutError,
  runHarnessCase,
  spawnHarnessChild,
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
