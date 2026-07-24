import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createStdioChannel, type JsonObject } from '@clowder-ai/plugin-sdk';

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

  for (const chunk of input) {
    child.stdin.write(chunk);
  }
  child.stdin.end();
  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function runFatalRuntimeChildWithoutClosingInput(): Promise<ChildResult | undefined> {
  const child = spawn(process.execPath, ['--import', 'tsx', childFixture.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, STDIO_RUNTIME_TEST_READY: '1' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child.stderr, 'data').then(([chunk]) => {
        assert.equal(Buffer.from(chunk as Uint8Array).toString('utf8'), 'ready\n');
      }),
      once(child, 'close').then(([code]) => {
        throw new Error(`child closed before its runtime became ready (exit ${code})`);
      }),
      new Promise<never>((_resolve, reject) => {
        readyTimer = setTimeout(() => reject(new Error('child runtime did not become ready')), 2_000);
      }),
    ]);
  } finally {
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
    }
  }

  child.stdin.write(Buffer.from('this is not JSON\n', 'utf8'));

  try {
    return await Promise.race([
      once(child, 'close').then(([code]) => ({
        code: code as number | null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })),
      new Promise<undefined>(resolve => setTimeout(resolve, 250)),
    ]);
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
  }
}

test('echoes a legal NDJSON frame through a real child that imports only the public SDK runtime', async () => {
  const result = await runRuntimeChild([
    Buffer.from('{"type":"ping","payload":{"sequence":1}}\n', 'utf8'),
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), {
    type: 'echo',
    payload: { type: 'ping', payload: { sequence: 1 } },
  });
});

test('fails closed when the child runtime receives a malformed NDJSON frame', async () => {
  const result = await runRuntimeChild([
    Buffer.from('this is not JSON\n', 'utf8'),
    Buffer.from('{"type":"must-not-run"}\n', 'utf8'),
  ]);

  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.byteLength, 0, 'fatal framing must not emit a response');
});

test('terminates the standalone child immediately after fatal framing instead of waiting for stdin EOF', async () => {
  const result = await runFatalRuntimeChildWithoutClosingInput();

  if (result === undefined) {
    assert.fail('fatal framing must close the process-owned transport');
  }
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.byteLength, 0);
});

test('keeps protocol stdout free of diagnostics and non-frame bytes', async () => {
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

test('preserves raw frame bytes for pre-parse validation at the SDK handler boundary', async () => {
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

test('rejects a Readable that is already in text mode before invalid UTF-8 can be replaced', () => {
  const input = new PassThrough();
  input.setEncoding('utf8');

  assert.throws(
    () => createStdioChannel(input, new PassThrough(), { onFrame: () => undefined }),
    RangeError,
  );
});

test('fails closed on an object-mode chunk before a later legal byte frame can run', () => {
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

test('detaches all caller-owned stream listeners after a fatal frame and later close', () => {
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

test('classifies a native writable callback failure as an output fault', async () => {
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

test('pauses upstream while a handler is pending and resumes in frame order after it settles', async () => {
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

test('keeps a multi-frame chunk paused until its first handler settles, then preserves order', async () => {
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
      completionTimer = setTimeout(() => resolve('timed-out'), 250);
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

test('does not parse a large single chunk past its blocked first frame', async () => {
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

test('bounds LF scanning to the current decode slice for an unterminated large chunk', () => {
  const scanned = { total: 0 };
  const chunk = new TrackingBytes(2 * 1024 * 1024);
  trackedScans.set(chunk.buffer, scanned);
  chunk.fill(0x78);
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
    channel.close();
  } finally {
    trackedScans.delete(chunk.buffer);
  }
});

test('excludes stale dist files from the packed SDK artifact', async () => {
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
