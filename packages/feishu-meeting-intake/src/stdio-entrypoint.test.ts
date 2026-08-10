import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { SessionBinding } from '@clowder-ai/plugin-contract';

import {
  meetingIntakeStatePath,
  readRuntimeClaims,
  startFeishuMeetingIntakeStdio,
} from './stdio-entrypoint.js';
import { normalizeGeneratedArtifact } from './artifact.js';

const DIGEST = `sha512-${'A'.repeat(86)}==`;
const CLAIMS = {
  CLOWDER_PLUGIN_ID: 'dev.clowder.feishu-meeting-intake',
  CLOWDER_PACKAGE_DIGEST: DIGEST,
  CLOWDER_CONTRACT_VERSION: '0.1.0-beta.9',
  CLOWDER_WIRE_VERSION: '0.1.0',
  PATH: '/must/not/be-read',
  NPM_TOKEN: 'must-not-leak',
};

function binding(): SessionBinding {
  return {
    pluginId: CLAIMS.CLOWDER_PLUGIN_ID,
    packageDigest: CLAIMS.CLOWDER_PACKAGE_DIGEST,
    contractVersion: CLAIMS.CLOWDER_CONTRACT_VERSION,
    wireVersion: CLAIMS.CLOWDER_WIRE_VERSION,
    pluginInstanceId: '../host-instance',
    brokerSessionId: 'broker-session-1',
    grantRevision: 1,
    effectiveGrants: ['events.publish'],
    bindingNonce: 'binding-nonce-1',
  };
}

function lineReader(stream: PassThrough): () => Promise<Record<string, unknown>> {
  let buffer = '';
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (waiter === undefined) frames.push(frame);
      else waiter(frame);
    }
  });
  return () => {
    const frame = frames.shift();
    return frame === undefined
      ? new Promise(resolve => waiters.push(resolve))
      : Promise.resolve(frame);
  };
}

function send(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

test('reads only the four Host claims and rejects malformed authority', () => {
  assert.deepEqual(readRuntimeClaims(CLAIMS), {
    pluginId: CLAIMS.CLOWDER_PLUGIN_ID,
    packageDigest: CLAIMS.CLOWDER_PACKAGE_DIGEST,
    contractVersion: CLAIMS.CLOWDER_CONTRACT_VERSION,
    wireVersion: CLAIMS.CLOWDER_WIRE_VERSION,
  });
  assert.throws(() => readRuntimeClaims({ ...CLAIMS, CLOWDER_PACKAGE_DIGEST: 'not-a-digest' }));
  assert.throws(() => readRuntimeClaims({ ...CLAIMS, CLOWDER_PLUGIN_ID: undefined }));
});

test('derives durable instance state without trusting the Host identifier as a path', () => {
  const path = meetingIntakeStatePath('/Users/example', '../host-instance');
  assert.match(path, /^\/Users\/example\/\.clowder-ai\/plugin-state\/feishu-meeting-intake\/[a-f0-9]{64}\.json$/u);
  assert.doesNotMatch(path, /host-instance/u);
});

test('handshakes before source startup, publishes after ready, and rejects reserved rows', async () => {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();
  const nextFrame = lineReader(pluginToHost);
  let sourceStarts = 0;
  let pollCalls = 0;
  let resolveFatal!: (error: unknown) => void;
  const fatal = new Promise<unknown>(resolve => {
    resolveFatal = resolve;
  });
  const controller = startFeishuMeetingIntakeStdio({
    input: hostToPlugin,
    output: pluginToHost,
    claims: readRuntimeClaims(CLAIMS),
    createRuntime: ({ publisher }) => {
      sourceStarts += 1;
      return {
        pollOnce: async (signal) => {
          pollCalls += 1;
          if (pollCalls === 1) {
            await publisher.publish(normalizeGeneratedArtifact({
              artifactId: 'om_abc123',
              kind: 'minute',
              revision: 'event-1',
              generatedAt: '2026-08-10T17:00:00.000Z',
              title: 'F292 dogfood',
            }));
            return { discovered: 1, published: 1 };
          }
          await new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { discovered: 0, published: 0 };
        },
        importArtifact: async () => ({ discovered: 0, published: 0 }),
      };
    },
    onFatal: resolveFatal,
  });

  const hello = await nextFrame();
  assert.equal(hello.method, 'broker.hello');
  assert.deepEqual((hello.params as { input: unknown }).input, readRuntimeClaims(CLAIMS));
  assert.equal(sourceStarts, 0);

  send(hostToPlugin, { jsonrpc: '2.0', id: hello.id, result: binding() });
  const ready = await nextFrame();
  assert.equal(ready.method, 'broker.ready');
  assert.deepEqual((ready.params as { input: unknown }).input, { bindingNonce: 'binding-nonce-1' });
  assert.equal(sourceStarts, 0);

  send(hostToPlugin, { jsonrpc: '2.0', id: ready.id, result: null });
  await controller.activated;
  assert.equal(sourceStarts, 1);
  assert.equal(pollCalls, 1);

  const publish = await nextFrame();
  assert.equal(publish.method, 'events.publish');
  assert.equal(
    ((publish.params as { input: { source: { handle: string } } }).input.source.handle),
    'feishu://meeting-artifacts/minute/om_abc123?revision=event-1',
  );
  send(hostToPlugin, {
    jsonrpc: '2.0',
    id: publish.id,
    result: { publicationId: 'publication-1', disposition: 'accepted' },
  });

  while (pollCalls < 2) await new Promise<void>(resolve => setImmediate(resolve));

  const framePromise = nextFrame();
  send(hostToPlugin, {
    jsonrpc: '2.0',
    id: 'reserved-1',
    method: 'messaging.send',
    params: { meta: { deadlineUnixMs: Date.now() + 10_000 }, input: {} },
  });
  const rejected = await framePromise;
  assert.equal(rejected.id, 'reserved-1');
  assert.deepEqual(rejected.error, { code: -32602, message: 'Invalid params' });
  assert.equal(pollCalls, 2, 'reserved rows must have zero business dispatch');

  send(hostToPlugin, {
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: Date.now() + 10_000 },
      input: { grantRevision: 2, effectiveGrants: [] },
    },
  });
  const authorityLoss = await fatal;
  assert.ok(authorityLoss instanceof Error);
  assert.equal(authorityLoss.message, 'stdio runtime stopped after HANDLER_ERROR');
  assert.ok(authorityLoss.cause instanceof Error);
  assert.match(authorityLoss.cause.message, /grant authority changed/u);

  await controller.close();
});
