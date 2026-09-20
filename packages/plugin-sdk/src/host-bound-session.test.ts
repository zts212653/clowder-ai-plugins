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
  grantRevision: 1,
  effectiveGrants: ['messaging.send', 'events.publish', 'onMessage'] as const,
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

const eventInput = {
  signalType: 'connector.message.received.v1',
  eventId: 'telegram:update-42',
  idempotencyKey: 'telegram:update-42',
  occurredAt: '2026-09-19T00:00:00.000Z',
  payload: { updateId: '42' },
  source: { handle: 'telegram://updates/42' },
} as const;

const eventPublishing = {
  declaredSignals: [{
    type: eventInput.signalType,
    schemaRef: 'schemas/connector-message.schema.json',
    epistemicStatus: 'observation',
    privacyClass: 'content-adjacent',
    sourceClass: 'remote-service',
  }] as const,
  signalSchemas: {
    'schemas/connector-message.schema.json': {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          properties: { updateId: { type: 'string' } },
          required: ['updateId'],
          additionalProperties: false,
        },
        source: {
          type: 'object',
          properties: { handle: { const: 'telegram://updates/42' } },
          required: ['handle'],
          additionalProperties: false,
        },
      },
      required: ['payload', 'source'],
      additionalProperties: false,
    },
  },
} as const;

function createHarness(
  onMessage?: Parameters<typeof createHostBoundSession>[0]['onMessage'],
  publishing?: Parameters<typeof createHostBoundSession>[0]['eventPublishing'],
) {
  const pluginInput = new PassThrough();
  const pluginOutput = new PassThrough();
  const calls: Array<{ method: string; input: unknown }> = [];
  let hostSequence = 0;
  const hostInFlight = new Map<string, { method: 'host.lifecycle.ping' | 'host.lifecycle.drain' | 'host.messaging.deliver'; resolve(value: unknown): void; reject(error: unknown): void }>();

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
    onMessage,
    eventPublishing: publishing,
  });

  const hostCall = <Result>(
    method: 'host.lifecycle.ping' | 'host.lifecycle.drain' | 'host.messaging.deliver',
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
  assert.equal(harness.session.events, undefined);
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

test('exposes events.publish only through declared-signal validation', async () => {
  const harness = createHarness(undefined, eventPublishing);
  await harness.session.ready;

  assert.ok(harness.session.events);
  assert.deepEqual(await harness.session.events.publish(eventInput), {
    publicationId: 'publication-1',
    disposition: 'accepted',
  });
  assert.equal(harness.calls.at(-1)?.method, 'events.publish');

  await assert.rejects(
    harness.session.events.publish({ ...eventInput, destination: { threadId: 'thread-1' } }),
    /input rejected/,
  );
  assert.equal(
    harness.calls.filter(call => call.method === 'events.publish').length,
    1,
    'authority-bearing input must fail before transport',
  );
  await closeHarness(harness.session, harness.host);
});

test('handles Host delivery, ping, monotonic grant replacement, and drain on one session', async () => {
  const deliveries: string[] = [];
  const harness = createHarness(input => {
    deliveries.push(input.deliveryId);
    return { accepted: true };
  });
  await harness.session.ready;

  const ping = await harness.hostCall<{ nonce: string }>('host.lifecycle.ping', { nonce: 'ping-1' });
  assert.deepEqual(ping, { nonce: 'ping-1' });

  const delivered = await harness.hostCall<{ deliveryId: string }>('host.messaging.deliver', {
    deliveryId: 'delivery-1',
    threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
    envelope: inboundEnvelope,
  });
  assert.deepEqual(delivered, { deliveryId: 'delivery-1' });
  assert.deepEqual(deliveries, ['delivery-1']);

  await harness.host.send({
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: Date.now() + 1_000 },
      input: { grantRevision: 2, effectiveGrants: ['onMessage'] },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    harness.session.messaging.send({
      address: { kind: 'connector_binding', handle: 'connector-binding-1' },
      idempotencyKey: 'telegram:update-43',
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: 'text-2', kind: 'text', payload: { text: 'must fail' } }],
      },
    }),
    /does not include messaging\.send/,
  );

  await harness.host.send({
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: Date.now() + 1_000 },
      input: { grantRevision: 3, effectiveGrants: ['messaging.send', 'onMessage'] },
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  const drained = await harness.hostCall<null>('host.lifecycle.drain', {
    deadlineUnixMs: Date.now() + 1_000,
  });
  assert.equal(drained, null);
  assert.equal(harness.session.liveness.isLive(), false);
  await assert.rejects(
    harness.session.messaging.send({
      address: { kind: 'connector_binding', handle: 'connector-binding-1' },
      idempotencyKey: 'telegram:update-44',
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: 'text-3', kind: 'text', payload: { text: 'after drain' } }],
      },
    }),
    /not live/,
  );
  await closeHarness(harness.session, harness.host);
});

test('fails closed on stale grant notifications', async () => {
  const harness = createHarness(() => ({ accepted: true }));
  await harness.session.ready;

  await harness.host.send({
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: Date.now() + 1_000 },
      input: { grantRevision: 1, effectiveGrants: ['messaging.send', 'onMessage'] },
    },
  });
  await harness.session.closed;
  assert.equal(harness.session.liveness.isLive(), false);
});
