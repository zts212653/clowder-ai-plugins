import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createHostBoundSession,
  createStdioChannel,
  type HostBoundSession,
  type JsonObject,
} from '@clowder-ai/plugin-sdk';

const claims = {
  pluginId: 'official.connector.telegram',
  packageDigest: `sha512-${'A'.repeat(85)}A==`,
  contractVersion: '0.1.0',
  wireVersion: '0.1.0',
} as const;

const binding = {
  ...claims,
  pluginInstanceId: 'telegram-1',
  brokerSessionId: 'broker-1',


  bindingNonce: 'nonce-1',
};

const inboundEnvelope = {
  messageId: 'message-1',
  revision: 1,
  threadId: 'thread-1',
  actor: { kind: 'cat', id: 'cat-1' },
  audience: { kind: 'public' },
  occurredAt: '2026-09-19T00:00:00.000Z',
  payload: {
    provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' },
    elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }],
  },
} as const;

function createHarness(
  delivery?: Parameters<typeof createHostBoundSession>[0]['delivery'],
) {
  const pluginInput = new PassThrough();
  const pluginOutput = new PassThrough();
  const calls: Array<{ method: string; input: unknown }> = [];
  let hostSequence = 0;
  const hostInFlight = new Map<string, { method: 'host.lifecycle.ping' | 'host.messaging.deliver'; resolve(value: unknown): void; reject(error: unknown): void }>();

  const host = createStdioChannel(pluginOutput, pluginInput, {
    async onFrame(frame) {
      const value = frame.value;
      if (!('method' in value)) {
        assert.equal(typeof value.id, 'string');
        const pending = hostInFlight.get(value.id as string);
        assert.ok(pending);
        hostInFlight.delete(value.id as string);
        if ('result' in value) pending.resolve(value.result);
        else pending.reject(value.error);
        return undefined;
      }
      assert.equal(typeof value.id, 'string');
      const params = value.params as { input: unknown };
      calls.push({ method: value.method as string, input: params.input });
      if (value.method === 'broker.hello') {
        return { jsonrpc: '2.0', id: value.id as string, result: binding };
      }
      if (value.method === 'broker.ready') {
        return { jsonrpc: '2.0', id: value.id as string, result: null };
      }
      if (value.method === 'messaging.send') {
        return {
          jsonrpc: '2.0',
          id: value.id as string,
          result: {
            messageId: 'message-1',
            threadId: 'thread-1',
            revision: 1,
            messageHandle: { kind: 'message', token: 'message-handle-1' },
            publishSequence: 1,
          },
        };
      }
      if (value.method === 'events.publish') {
        return {
          jsonrpc: '2.0',
          id: value.id as string,
          result: { publicationId: 'publication-1', disposition: 'accepted' },
        };
      }
      throw new Error(`unexpected plugin call ${String(value.method)}`);
    },
  });

  const session = createHostBoundSession({
    claims,
    input: pluginInput,
    output: pluginOutput,
    requestTimeoutMs: 1_000,
    delivery,
  });

  const hostCall = <Result>(
    method: 'host.lifecycle.ping' | 'host.messaging.deliver',
    input: JsonObject,
  ): Promise<Result> => {
    hostSequence += 1;
    const id = `host-${hostSequence}`;
    const result = new Promise<Result>((resolve, reject) => {
      hostInFlight.set(id, { method, resolve: value => resolve(value as Result), reject });
    });
    void host.send({
      jsonrpc: '2.0',
      id,
      method,
      params: { meta: { deadlineUnixMs: Date.now() + 1_000 }, input },
    });
    return result;
  };

  return { calls, host, hostCall, session };
}

async function closeHarness(session: HostBoundSession, host: { close(): void }): Promise<void> {
  session.close();
  host.close();
  await session.closed;
}

test('completes the broker handshake and exposes a validated messaging client', async () => {
  const harness = createHarness();
  await harness.session.ready;

  assert.equal(harness.session.state.phase, 'activated');
  assert.equal(harness.session.liveness.isLive(), true);
  assert.equal('call' in harness.session, false, 'the composed session must not expose a raw wire call');
  assert.equal(Object.hasOwn(harness.session,'events'),false);
  assert.deepEqual(harness.calls.slice(0, 2).map(call => call.method), ['broker.hello', 'broker.ready']);

  const receipt = await harness.session.messaging.send({
    address: { kind: 'connector_binding', handle: 'connector-binding-1' },
    idempotencyKey: 'telegram:update-42',
    sourceEventId: 'update-42',
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello from Telegram' } }],
    },
  });

  assert.equal(receipt.threadId, 'thread-1');
  assert.equal(harness.calls.at(-1)?.method, 'messaging.send');
  await closeHarness(harness.session, harness.host);
});



test('exec status is delivered by the same handler and only its receipt is acknowledged', async () => {
  const seen: unknown[] = [];
  const harness = createHarness(input => {seen.push(input);return {deliveryId: input.deliveryId};});
  try {
    await harness.session.ready;
    const input = {kind: 'execution_status', executionId:'execution-1', deliveryId:'delivery-1', threadId:'thread-1',state:'resumed'};
    assert.deepEqual(await harness.hostCall('host.messaging.deliver',input),{deliveryId:'delivery-1'});
    assert.deepEqual(seen,[input]);
  } finally {await closeHarness(harness.session,harness.host);}
});
