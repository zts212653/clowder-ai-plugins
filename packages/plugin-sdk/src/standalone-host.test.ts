import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  loadStandaloneManifest,
  ManifestStartupError,
  startStandaloneHost,
  type JsonObject,
} from '@clowder-ai/plugin-sdk';

const validManifest = {
  pluginId: 'example.loopback',
  version: '1.0.0',
  contractVersion: '0.1.0',
  name: 'Example loopback plugin',
  features: [
    {
      id: 'loopback',
      name: 'Loopback',
      resources: [],
      capabilities: [],
    },
  ],
  runtime: { transport: 'stdio', entrypoint: 'dist/index.js' },
} as const;

test('loads a manifest file only after the contract validates its full content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-sdk-manifest-'));
  const manifestPath = join(directory, 'manifest.json');
  try {
    await writeFile(manifestPath, JSON.stringify(validManifest), 'utf8');
    assert.deepEqual(await loadStandaloneManifest(manifestPath), validManifest);

    await writeFile(
      manifestPath,
      JSON.stringify({ ...validManifest, runtime: { transport: 'stdio' } }),
      'utf8',
    );
    await assert.rejects(() => loadStandaloneManifest(manifestPath), ManifestStartupError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function collectFrames(output: PassThrough, count: number): Promise<readonly JsonObject[]> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      if (lines.length - 1 < count) {
        return;
      }
      output.off('data', onData);
      try {
        resolve(lines.slice(0, count).map(line => JSON.parse(line) as JsonObject));
      } catch (error) {
        reject(error);
      }
    };
    output.on('data', onData);
  });
}

test('fails closed on an invalid manifest before attaching a stdio transport', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const manifest = {
    ...validManifest,
    features: [
      {
        ...validManifest.features[0],
        capabilities: ['plugin.capability.that-does-not-exist'],
      },
    ],
  };

  assert.throws(
    () => startStandaloneHost({ manifest, input, output }),
    (error: unknown) => {
      assert.ok(error instanceof ManifestStartupError);
      assert.ok(error.errors.length > 0);
      return true;
    },
  );
  assert.equal(input.listenerCount('data'), 0, 'invalid manifest must not start stdio input');
  assert.equal(output.listenerCount('error'), 0, 'invalid manifest must not bind output handling');
});

test('rejects an incomplete external runtime manifest before attaching a stdio transport', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const manifest = {
    ...validManifest,
    runtime: { transport: 'stdio' },
  };

  assert.throws(() => startStandaloneHost({ manifest, input, output }), ManifestStartupError);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

test('rejects a schema-valid non-stdio manifest before attaching a stdio transport', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const manifest = {
    ...validManifest,
    runtime: { transport: 'ipc', entrypoint: 'dist/ipc.js' },
  };

  assert.throws(
    () => startStandaloneHost({ manifest, input, output }),
    /requires a manifest with runtime\.transport "stdio"/,
  );
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

test('responds to closed lifecycle rows only after the manifest is valid', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let drainedAt: number | undefined;
  const deadlineUnixMs = Date.now() + 60_000;
  const frames = collectFrames(output, 2);
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onDrain: ({ deadlineUnixMs }) => {
      drainedAt = deadlineUnixMs;
    },
  });

  input.end(
    Buffer.from(
      `{"jsonrpc":"2.0","id":"ping-1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":${deadlineUnixMs}},"input":{"nonce":"nonce-1"}}}\n` +
        `{"jsonrpc":"2.0","id":"drain-1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":${deadlineUnixMs}},"input":{"deadlineUnixMs":${deadlineUnixMs}}}}\n`,
      'utf8',
    ),
  );

  assert.deepEqual(await frames, [
    { jsonrpc: '2.0', id: 'ping-1', result: { nonce: 'nonce-1' } },
    { jsonrpc: '2.0', id: 'drain-1', result: null },
  ]);
  assert.equal(drainedAt, deadlineUnixMs, 'drain acknowledgement follows graceful shutdown work');
  channel.close();
});

test('returns Method Not Found for a valid ready handshake request without activating it', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output, 1);
  const channel = startStandaloneHost({ manifest: validManifest, input, output });
  const deadlineUnixMs = Date.now() + 60_000;

  input.end(
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'hello-1',
        method: 'broker.hello',
        params: {
          meta: { deadlineUnixMs },
          input: {
            pluginId: 'example.loopback',
            packageDigest: `sha512-${'A'.repeat(86)}==`,
            contractVersion: '0.1.0-beta.8',
            wireVersion: '0.1.0',
          },
        },
      }) + '\n',
      'utf8',
    ),
  );

  assert.deepEqual(await frames, [
    {
      jsonrpc: '2.0',
      id: 'hello-1',
      error: { code: -32601, message: 'Method not found' },
    },
  ]);
  assert.equal(channel.failed, false, 'an unconnected handshake must not close the shell');
  channel.close();
});

test('rejects an already-expired drain deadline without starting shutdown work', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let drainCalls = 0;
  const frames = collectFrames(output, 1);
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onDrain: () => {
      drainCalls += 1;
    },
  });
  const requestDeadline = Date.now() + 60_000;
  const expiredDrainDeadline = Date.now() - 1;

  input.end(
    Buffer.from(
      `{"jsonrpc":"2.0","id":"drain-1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":${requestDeadline}},"input":{"deadlineUnixMs":${expiredDrainDeadline}}}}\n`,
      'utf8',
    ),
  );

  assert.deepEqual(await frames, [
    {
      jsonrpc: '2.0',
      id: 'drain-1',
      error: { code: -32093, message: 'deadline expired', data: {} },
    },
  ]);
  assert.equal(drainCalls, 0);
  assert.equal(channel.failed, false);
  channel.close();
});

test('rejects a drain whose cleanup remains pending beyond its deadline', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let releaseDrain!: () => void;
  const blockedDrain = new Promise<void>(resolve => {
    releaseDrain = resolve;
  });
  const frames = collectFrames(output, 1);
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onDrain: () => blockedDrain,
  });
  const requestDeadline = Date.now() + 60_000;
  const drainDeadline = Date.now() + 20;

  input.end(
    Buffer.from(
      `{"jsonrpc":"2.0","id":"drain-1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":${requestDeadline}},"input":{"deadlineUnixMs":${drainDeadline}}}}\n`,
      'utf8',
    ),
  );

  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    frames.then(value => ({ kind: 'response' as const, value })),
    new Promise<{ readonly kind: 'timeout' }>(resolve => {
      observationTimer = setTimeout(() => resolve({ kind: 'timeout' }), 150);
    }),
  ]);
  if (observationTimer !== undefined) {
    clearTimeout(observationTimer);
  }
  releaseDrain();

  assert.notEqual(outcome.kind, 'timeout', 'drain must not wait past its deadline');
  if (outcome.kind === 'response') {
    assert.deepEqual(outcome.value, [
      {
        jsonrpc: '2.0',
        id: 'drain-1',
        error: { code: -32093, message: 'deadline expired', data: {} },
      },
    ]);
  }
  assert.equal(channel.failed, false);
  channel.close();
});

test('does not expire a drain whose valid deadline spans Node timer chunks', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output, 1);
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onDrain: () => new Promise<void>(resolve => setTimeout(resolve, 20)),
  });
  const requestDeadline = Date.now() + 60_000;
  const drainDeadline = Date.now() + 2 ** 40;

  input.end(
    Buffer.from(
      `{"jsonrpc":"2.0","id":"drain-1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":${requestDeadline}},"input":{"deadlineUnixMs":${drainDeadline}}}}\n`,
      'utf8',
    ),
  );

  assert.deepEqual(await frames, [
    { jsonrpc: '2.0', id: 'drain-1', result: null },
  ]);
  assert.equal(channel.failed, false);
  channel.close();
});

test('accepts a legal grants notification without manufacturing a response', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let fatalError: unknown;
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onFatal: error => {
      fatalError = error;
    },
  });
  const stdout: Buffer[] = [];
  output.on('data', (chunk: Buffer) => stdout.push(chunk));
  const ended = new Promise<void>(resolve => input.once('end', resolve));

  input.end(
    Buffer.from(
      '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":1,"effectiveGrants":[]}}}\n',
      'utf8',
    ),
  );
  await ended;
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(fatalError, undefined);
  assert.equal(channel.failed, false);
  assert.equal(Buffer.concat(stdout).byteLength, 0);
  channel.close();
});

test('closes without emitting a frame when S1 rejects a protocol violation', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let reportFatal!: (error: unknown) => void;
  const fatal = new Promise<unknown>(resolve => {
    reportFatal = resolve;
  });
  const channel = startStandaloneHost({
    manifest: validManifest,
    input,
    output,
    onFatal: error => reportFatal(error),
  });
  const stdout: Buffer[] = [];
  output.on('data', (chunk: Buffer) => stdout.push(chunk));

  input.end(
    Buffer.from(
      '{"jsonrpc":"2.0","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"nonce-1"}}}\n',
      'utf8',
    ),
  );

  const error = await fatal;
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'stdio runtime stopped after HANDLER_ERROR');
  assert.equal(channel.failed, true);
  assert.equal(Buffer.concat(stdout).byteLength, 0);
});

test('emits a parse error and continues with the next complete frame', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output, 2);
  const channel = startStandaloneHost({ manifest: validManifest, input, output });

  input.end(
    Buffer.from(
      '{invalid json\n' +
        '{"jsonrpc":"2.0","id":"ping-1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"nonce-1"}}}\n',
      'utf8',
    ),
  );

  assert.deepEqual(await frames, [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: 'ping-1', result: { nonce: 'nonce-1' } },
  ]);
  assert.equal(channel.failed, false);
  channel.close();
});
