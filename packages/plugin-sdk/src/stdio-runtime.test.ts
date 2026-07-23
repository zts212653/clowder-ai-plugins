import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { createStdioChannel, type JsonObject } from '@clowder-ai/plugin-sdk';

const childFixture = new URL('./test-fixtures/stdio-child.ts', import.meta.url);

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
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
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
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
  const input = new PassThrough();
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
  });

  input.write(Buffer.from('{"sequence":1}\n{"sequence":2}\n{"sequence":3}\n', 'utf8'));
  await firstStartedPromise;
  assert.equal(input.readableFlowing, false);

  releaseFirst();
  await allHandledPromise;
  assert.deepEqual(handled, [1, 2, 3]);
  channel.close();
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
