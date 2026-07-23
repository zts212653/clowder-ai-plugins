import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

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
