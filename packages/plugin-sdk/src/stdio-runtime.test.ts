import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createStdioChannel, type JsonObject } from '@clowder-ai/plugin-sdk';

// Child-process cases must fail on a missed deadline instead of wedging the
// runner: a stuck child otherwise keeps stdin open and the run never exits.
const TEST_TIMEOUT_MS = 30_000;
const CHILD_CLOSE_TIMEOUT_MS = 5_000;
const boundedTest = (name: string, fn: () => unknown) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn as () => void | Promise<void>);

async function awaitChildClose(
  child: ReturnType<typeof spawn>,
): Promise<[number | null, NodeJS.Signals | null]> {
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      once(child, 'close'),
      new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('child did not close before the deadline'));
        }, CHILD_CLOSE_TIMEOUT_MS);
      }),
    ])) as [number | null, NodeJS.Signals | null];
  } finally {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
    }
  }
}

const childFixture = new URL('./test-fixtures/stdio-child.ts', import.meta.url);

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
}

const trackedScans = new Map<ArrayBuffer, { total: number }>();

class TrackingBytes extends Uint8Array {
  constructor(source: number | ArrayBuffer, byteOffset?: number, length?: number) {
    if (typeof source === 'number') {
      super(source);
    } else {
      super(source, byteOffset, length);
    }
  }

  override indexOf(searchElement: number, fromIndex?: number): number {
    const scanned = trackedScans.get(this.buffer as ArrayBuffer);
    if (scanned !== undefined) {
      scanned.total += this.byteLength - (fromIndex ?? 0);
    }
    return super.indexOf(searchElement, fromIndex);
  }
}

async function runRuntimeChild(input: readonly Buffer[]): Promise<ChildResult> {
  const child = spawn(process.execPath, ['--import', 'tsx', childFixture.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  // An early child death makes stdin writes reject with EPIPE; the exit code
  // assertion below is the verdict, so the stream error is not fatal here.
  child.stdin.on('error', () => {});

  for (const chunk of input) {
    child.stdin.write(chunk);
  }
  child.stdin.end();
  const [code] = await awaitChildClose(child);
  return {
    code,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

// Milliseconds to wait for the fixture runtime to announce readiness before
// treating the child as wedged. Injectable so a test can force that path.
// A ready fixture reports in well under a second; this only bounds a truly
// wedged child, so it must outlive CPU contention rather than race it.
const FATAL_CHILD_READY_TIMEOUT_MS = 10_000;

// Anti-wedge bound for "the runtime must terminate without waiting for stdin
// EOF": a correct runtime closes promptly, a broken one must fail this test
// instead of wedging the runner. Not a delay — verdicts are data-driven.
const FATAL_CLOSE_DEADLINE_MS = 5_000;

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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return !processIsAlive(pid);
}

async function runFatalRuntimeChildWithoutClosingInput(
  options: { readyTimeoutMs?: number; onSpawn?: (pid: number) => void } = {},
): Promise<ChildResult | undefined> {
  const child = spawn(process.execPath, ['--import', 'tsx', childFixture.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, STDIO_RUNTIME_TEST_READY: '1' },
  });
  // Registered once at spawn: every teardown path reaps the same close
  // event, so a child that already exited never makes teardown wait out
  // the close deadline.
  const childClosed = once(child, 'close');
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on('error', () => {});

  try {
    if (child.pid !== undefined) {
      options.onSpawn?.(child.pid);
    }
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closedBeforeReady = childClosed.then(([code]) => {
        throw new Error(`child closed before its runtime became ready (exit ${code})`);
      });
      // If readiness wins the race this branch settles later with a
      // rejection the race no longer observes; keep it from surfacing as
      // an unhandled rejection.
      void closedBeforeReady.catch(() => {});
      await Promise.race([
        once(child.stderr, 'data').then(([chunk]) => {
          assert.equal(Buffer.from(chunk as Uint8Array).toString('utf8'), 'ready\n');
        }),
        closedBeforeReady,
        new Promise<never>((_resolve, reject) => {
          readyTimer = setTimeout(
            () => reject(new Error('child runtime did not become ready')),
            options.readyTimeoutMs ?? FATAL_CHILD_READY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
      }
    }

    child.stdin.write(Buffer.from('this is not JSON\n', 'utf8'));

    return await Promise.race([
      childClosed.then(([code]) => ({
        code: code as number | null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })),
      new Promise<undefined>(resolve => setTimeout(resolve, FATAL_CLOSE_DEADLINE_MS)),
    ]);
  } finally {
    // Every exit path — readiness timeout, fatal framing, assertion
    // failure — must tear the child down and reap it. A stdin-waiting
    // child that survives here keeps the test runner's event loop alive
    // forever, which is the runner wedge this suite exists to prevent.
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await awaitChildClose(child).catch(() => {});
    }
  }
}

boundedTest('echoes a legal NDJSON frame through a real child that imports only the public SDK runtime', async () => {
  const result = await runRuntimeChild([
    Buffer.from('{"type":"ping","payload":{"sequence":1}}\n', 'utf8'),
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), {
    type: 'echo',
    payload: { type: 'ping', payload: { sequence: 1 } },
  });
});

boundedTest('fails closed when the child runtime receives a malformed NDJSON frame', async () => {
  const result = await runRuntimeChild([
    Buffer.from('this is not JSON\n', 'utf8'),
    Buffer.from('{"type":"must-not-run"}\n', 'utf8'),
  ]);

  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.byteLength, 0, 'fatal framing must not emit a response');
});

boundedTest('terminates the standalone child immediately after fatal framing instead of waiting for stdin EOF', async () => {
  const result = await runFatalRuntimeChildWithoutClosingInput();

  if (result === undefined) {
    assert.fail('fatal framing must close the process-owned transport');
  }
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.byteLength, 0);
});

boundedTest('reaps the child when its runtime never becomes ready', async () => {
  let childPid: number | undefined;
  await assert.rejects(
    runFatalRuntimeChildWithoutClosingInput({
      // Far below the fixture's tsx import + runtime startup time, so the
      // readiness deadline always expires first even on a fast machine.
      readyTimeoutMs: 1,
      onSpawn: (pid) => {
        childPid = pid;
      },
    }),
    /did not become ready/,
  );

  assert.notEqual(childPid, undefined);
  assert.equal(
    await waitForProcessExit(childPid as number, 5_000),
    true,
    'a child that never became ready must still be reaped',
  );
});

boundedTest('keeps protocol stdout free of diagnostics and non-frame bytes', async () => {
  const result = await runRuntimeChild([
    Buffer.from('{"type":"first"}\n{"type":"second"}\n', 'utf8'),
  ]);

  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.toString('utf8').split('\n');
  assert.equal(lines.at(-1), '', 'each protocol frame must end in LF');
  assert.deepEqual(lines.slice(0, -1).map(line => JSON.parse(line)), [
    { type: 'echo', payload: { type: 'first' } },
    { type: 'echo', payload: { type: 'second' } },
  ]);
});

boundedTest('preserves raw frame bytes for pre-parse validation at the SDK handler boundary', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const raw = '{"id":"first","id":"second"}';
  let received: unknown;
  let handled!: () => void;
  const handledFrame = new Promise<void>(resolve => {
    handled = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: frame => {
      received = frame;
      handled();
      return undefined;
    },
  });

  input.end(Buffer.from(`${raw}\n`, 'utf8'));
  await handledFrame;

  const frame = received as { readonly raw: Uint8Array; readonly value: JsonObject };
  assert.equal(Buffer.from(frame.raw).toString('utf8'), raw);
  assert.deepEqual(frame.value, { id: 'second' });
  channel.close();
});

boundedTest('rejects a Readable that is already in text mode before invalid UTF-8 can be replaced', () => {
  const input = new PassThrough();
  input.setEncoding('utf8');

  assert.throws(
    () => createStdioChannel(input, new PassThrough(), { onFrame: () => undefined }),
    RangeError,
  );
});

boundedTest('fails closed on an object-mode chunk before a later legal byte frame can run', () => {
  const input = new PassThrough({ objectMode: true });
  const output = new PassThrough();
  let handled = false;
  let fatalReason: string | undefined;
  const channel = createStdioChannel(input, output, {
    onFrame: () => {
      handled = true;
      return undefined;
    },
    onFatal: error => {
      fatalReason = error.reason;
    },
  });

  input.write({ invalid: 'object chunk' });
  input.write(Buffer.from('{"must":"not-run"}\n', 'utf8'));

  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'INPUT_ERROR');
  assert.equal(handled, false);
  channel.close();
});

boundedTest('detaches all caller-owned stream listeners after a fatal frame and later close', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = createStdioChannel(input, output, { onFrame: () => undefined });

  input.write(Buffer.from('not-json\n', 'utf8'));
  channel.close();

  assert.equal(channel.failed, true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

boundedTest('keeps output error handling through a write that settles after channel close', async () => {
  const input = new PassThrough();
  const writeFailure = new Error('late broken pipe');
  class CallbackThenErrorOutput extends EventEmitter {
    write(_chunk: Uint8Array, callback: (error?: Error) => void): boolean {
      setImmediate(() => {
        callback(writeFailure);
        process.nextTick(() => this.emit('error', writeFailure));
      });
      return false;
    }
  }
  const output = new CallbackThenErrorOutput();
  let fatalReason: string | undefined;
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  let reportError!: () => void;
  const errorPromise = new Promise<void>(resolve => {
    reportError = resolve;
  });
  // Keep the test process alive if the runtime incorrectly removes only its
  // listener before the modeled native error is emitted.
  output.once('error', () => reportError());
  const channel = createStdioChannel(input, output as unknown as Writable, {
    onFrame: () => undefined,
    onFatal: error => {
      fatalReason = error.reason;
      reportFatal();
    },
  });

  const sending = channel.send({ request: 'send' });
  channel.close();
  assert.equal(
    output.listenerCount('error'),
    2,
    'the runtime listener must remain until the pending write has settled',
  );
  await assert.rejects(sending, { message: 'late broken pipe' });
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.all([fatalPromise, errorPromise]).then(() => 'completed' as const),
    new Promise<'timed-out'>(resolve => {
      completionTimer = setTimeout(() => resolve('timed-out'), 5_000);
    }),
  ]);
  if (completionTimer !== undefined) {
    clearTimeout(completionTimer);
  }

  assert.equal(outcome, 'completed', 'late output errors must still reach the runtime');
  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'OUTPUT_ERROR');
});

boundedTest('detaches output error handling after a successful pre-close write settles', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = createStdioChannel(input, output, { onFrame: () => undefined });

  const sending = channel.send({ request: 'send' });
  channel.close();
  await sending;
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(channel.failed, false);
  assert.equal(output.listenerCount('error'), 0);
});

boundedTest('fails closed when input closes with a truncated frame instead of ending', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let fatalReason: string | undefined;
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: () => undefined,
    onFatal: error => {
      fatalReason = error.reason;
      reportFatal();
    },
  });

  input.write(Buffer.from('{"truncated":true}', 'utf8'));
  input.destroy();
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    fatalPromise.then(() => 'failed' as const),
    new Promise<'timed-out'>(resolve => {
      completionTimer = setTimeout(() => resolve('timed-out'), 5_000);
    }),
  ]);
  if (completionTimer !== undefined) {
    clearTimeout(completionTimer);
  }

  assert.equal(outcome, 'failed', 'close without end must finalize the decoder');
  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'FRAME_ERROR');
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(input.listenerCount('close'), 0);
  assert.equal(output.listenerCount('error'), 0);
  channel.close();
});

boundedTest('fails closed when a destroyed output rejects a public send', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let fatalReason: string | undefined;
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: () => undefined,
    onFatal: error => {
      fatalReason = error.reason;
      reportFatal();
    },
  });
  output.destroy();

  await assert.rejects(channel.send({ request: 'send' }), {
    code: 'ERR_STREAM_DESTROYED',
  });
  await fatalPromise;

  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'OUTPUT_ERROR');
  channel.close();
});

boundedTest('classifies a destroyed output during a handler reply as an output fault', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let fatalReason: string | undefined;
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: () => ({ ok: true }),
    onFatal: error => {
      fatalReason = error.reason;
      reportFatal();
    },
  });
  output.destroy();

  input.write(Buffer.from('{"request":"reply"}\n', 'utf8'));
  await fatalPromise;

  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'OUTPUT_ERROR');
  channel.close();
});

boundedTest('classifies a native writable callback failure as an output fault', async () => {
  const input = new PassThrough();
  const writeFailure = new Error('broken pipe');
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(writeFailure);
    },
  });
  let fatalReason: string | undefined;
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const outputError = once(output, 'error');
  const channel = createStdioChannel(input, output, {
    onFrame: () => ({ ok: true }),
    onFatal: error => {
      fatalReason = error.reason;
      reportFatal();
    },
  });

  input.write(Buffer.from('{"request":"send"}\n', 'utf8'));
  await Promise.all([fatalPromise, outputError]);

  assert.equal(channel.failed, true);
  assert.equal(fatalReason, 'OUTPUT_ERROR');
  assert.equal(output.listenerCount('error'), 0);
  channel.close();
});

boundedTest('pauses upstream while a handler is pending and resumes in frame order after it settles', async () => {
  let framesPulled = 0;
  const input = new Readable({
    highWaterMark: 64,
    read() {
      if (framesPulled === 1_000) {
        this.push(null);
        return;
      }
      this.push(Buffer.from(`{"sequence":${framesPulled}}\n`, 'utf8'));
      framesPulled += 1;
    },
  });
  const output = new PassThrough();
  const handled: number[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  let threeHandled!: () => void;
  const threeHandledPromise = new Promise<void>(resolve => {
    threeHandled = resolve;
  });

  const channel = createStdioChannel(input, output, {
    onFrame: async frame => {
      const sequence = frame.value.sequence as number;
      handled.push(sequence);
      if (sequence === 0) {
        firstStarted();
        await firstMayFinish;
      }
      if (handled.length === 3) {
        threeHandled();
      }
      return undefined;
    },
  });

  await firstStartedPromise;
  const maxPullsBeforePause =
    Math.ceil(input.readableHighWaterMark / Buffer.byteLength('{"sequence":0}\n', 'utf8')) + 1;
  assert.ok(
    framesPulled <= maxPullsBeforePause,
    `a pending handler may buffer only one high-water-mark window (pulled ${framesPulled})`,
  );
  assert.equal(input.readableFlowing, false);

  releaseFirst();
  await threeHandledPromise;
  assert.deepEqual(handled, [0, 1, 2]);
  channel.close();
});

boundedTest('keeps a multi-frame chunk paused until its first handler settles, then preserves order', async () => {
  let emitted = false;
  const input = new Readable({
    read() {
      if (emitted) {
        return;
      }
      emitted = true;
      this.push(Buffer.from('{"sequence":1}\n{"sequence":2}\n{"sequence":3}\n', 'utf8'));
      this.push(null);
    },
  });
  const output = new PassThrough();
  const handled: number[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  let allHandled!: () => void;
  const allHandledPromise = new Promise<void>(resolve => {
    allHandled = resolve;
  });
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: async frame => {
      const sequence = frame.value.sequence as number;
      handled.push(sequence);
      if (sequence === 1) {
        firstStarted();
        await firstMayFinish;
      }
      if (handled.length === 3) {
        allHandled();
      }
      return undefined;
    },
    onFatal: reportFatal,
  });

  await firstStartedPromise;
  assert.equal(input.readableFlowing, false);

  releaseFirst();
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    allHandledPromise.then(() => 'handled' as const),
    fatalPromise.then(() => 'fatal' as const),
    new Promise<'timed-out'>(resolve => {
      completionTimer = setTimeout(() => resolve('timed-out'), 5_000);
    }),
  ]);
  if (completionTimer !== undefined) {
    clearTimeout(completionTimer);
  }
  assert.equal(outcome, 'handled', 'EOF must not close the decoder before the active chunk finishes');
  assert.deepEqual(handled, [1, 2, 3]);
  assert.equal(channel.failed, false);
  channel.close();
});

boundedTest('does not parse a large single chunk past its blocked first frame', async () => {
  const frameCount = 10_000;
  const input = new PassThrough();
  const output = new PassThrough();
  let handled = 0;
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  let reportFatal!: () => void;
  const fatalPromise = new Promise<void>(resolve => {
    reportFatal = resolve;
  });
  const channel = createStdioChannel(input, output, {
    onFrame: async frame => {
      assert.equal(frame.value.sequence, handled);
      handled += 1;
      if (handled === 1) {
        firstStarted();
        await firstMayFinish;
      }
      return undefined;
    },
    onFatal: () => reportFatal(),
  });
  const payload = `${Array.from(
    { length: frameCount },
    (_, sequence) => `{"sequence":${sequence}}\n`,
  ).join('')}not-json\n`;

  input.end(Buffer.from(payload, 'utf8'));
  const firstOutcome = await Promise.race([
    firstStartedPromise.then(() => 'started' as const),
    fatalPromise.then(() => 'fatal' as const),
  ]);
  assert.equal(firstOutcome, 'started', 'later frames must remain undecoded while the first blocks');
  assert.equal(handled, 1);
  assert.equal(channel.failed, false);

  releaseFirst();
  await fatalPromise;
  assert.equal(handled, frameCount, 'all legal frames resume in their original order');
  assert.equal(channel.failed, true);
  channel.close();
});

boundedTest('bounds LF scanning to the current decode slice for an unterminated large chunk', () => {
  const scanned = { total: 0 };
  const chunk = new TrackingBytes(2 * 1024 * 1024);
  trackedScans.set(chunk.buffer, scanned);
  chunk.fill(0x78);
  const originalConcat = Buffer.concat;
  let concatenatedBytes = 0;
  Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number): Buffer => {
    concatenatedBytes +=
      totalLength ?? list.reduce((total, segment) => total + segment.byteLength, 0);
    return originalConcat(list, totalLength);
  }) as typeof Buffer.concat;
  const input = new Readable({ read() {} });
  const output = new PassThrough();
  let fatalReason: string | undefined;
  const channel = createStdioChannel(input, output, {
    onFrame: () => undefined,
    onFatal: error => {
      fatalReason = error.reason;
    },
  });

  try {
    input.emit('data', chunk);

    assert.equal(channel.failed, true);
    assert.equal(fatalReason, 'FRAME_ERROR');
    assert.ok(
      scanned.total <= chunk.byteLength,
      `LF scanning must not rescan the attacker-controlled tail (${scanned.total} bytes scanned)`,
    );
    assert.ok(
      concatenatedBytes <= 2 * 1024 * 1024,
      `partial frames must not be repeatedly coalesced (${concatenatedBytes} bytes copied)`,
    );
    channel.close();
  } finally {
    Buffer.concat = originalConcat;
    trackedScans.delete(chunk.buffer);
  }
});

boundedTest('excludes stale dist files from the packed SDK artifact', async () => {
  const packageRoot = new URL('../', import.meta.url).pathname;
  const sentinel = join(packageRoot, 'dist', 'stale-review-sentinel.js');
  const packDirectory = await mkdtemp(join(tmpdir(), 'plugin-sdk-pack-'));

  try {
    await writeFile(sentinel, 'stale review sentinel\n');
    const { execFileSync } = await import('node:child_process');
    execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: packageRoot,
      stdio: 'pipe',
    });
    const { readdir } = await import('node:fs/promises');
    const tarball = (await readdir(packDirectory)).find(name => name.endsWith('.tgz'));
    assert.ok(tarball, 'pnpm pack must create a tarball');
    const listing = execFileSync('tar', ['-tzf', join(packDirectory, tarball)], {
      encoding: 'utf8',
    });
    assert.doesNotMatch(listing, /stale-review-sentinel\.js/);
  } finally {
    await rm(sentinel, { force: true });
    await rm(packDirectory, { force: true, recursive: true });
  }
});
