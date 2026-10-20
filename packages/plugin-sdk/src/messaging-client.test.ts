import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  MessagingRowInputByMethod,
  MessagingRowMethod,
  MessagingRowResultByMethod,
} from '@clowder-ai/plugin-contract';

import type { ActivatedHandshakeState, LocalHandshakeState } from './handshake-client.js';
import {
  MessagingClientError,
  createMessagingClient,
  type MessagingHostTransport,
} from './messaging-client.js';

const SEND_INPUT = {
  idempotencyKey: 'connector:telegram:update-42',
  address: { kind: 'connector_binding', handle: 'connector-binding-1' },
  draftAudience: { kind: 'public' },
  payload: {
    provenance: {
      origin: { kind: 'plugin', instanceId: 'plugin-instance-1' },
      epistemicStatus: 'user_intent',
    },
    elements: [
      { elementId: 'text-1', kind: 'text', payload: { text: 'hello from Telegram' } },
    ],
  },
} as const;

function activated(
  grants: ActivatedHandshakeState['binding']['effectiveGrants'] = ['messaging.send'],
): ActivatedHandshakeState {
  return {
    phase: 'activated',
    candidate: {
      pluginId: 'official.connector.telegram',
      packageDigest: `sha512-${'A'.repeat(86)}==`,
      contractVersion: '0.1.0',
      wireVersion: '0.1.0',
    },
    binding: {
      pluginId: 'official.connector.telegram',
      packageDigest: `sha512-${'A'.repeat(86)}==`,
      contractVersion: '0.1.0',
      wireVersion: '0.1.0',
      pluginInstanceId: 'plugin-instance-1',
      brokerSessionId: 'broker-session-1',
      grantRevision: 1,
      effectiveGrants: grants,
      bindingNonce: 'binding-nonce-1',
    },
    activation: { bindingNonce: 'binding-nonce-1' },
  };
}

class RecordingTransport implements MessagingHostTransport {
  readonly calls: Array<{ method: MessagingRowMethod; input: unknown }> = [];
  result: unknown = {
    messageId: 'message-1',
    threadId: 'thread-1',
    revision: 1,
    publishSequence: 1,
    messageHandle: { kind: 'message', token: 'message-handle-1' },
  };

  async call<Method extends Exclude<MessagingRowMethod, 'host.messaging.deliver'>>(
    method: Method,
    input: MessagingRowInputByMethod[Method],
  ): Promise<MessagingRowResultByMethod[Method]> {
    this.calls.push({ method, input });
    return this.result as MessagingRowResultByMethod[Method];
  }
}

function assertClientError(error: unknown, code: MessagingClientError['code']): boolean {
  assert.ok(error instanceof MessagingClientError);
  assert.equal(error.code, code);
  return true;
}

test('sends a validated draft through the frozen messaging.send row', async () => {
  const transport = new RecordingTransport();
  const client = createMessagingClient({
    transport,
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => true },
  });

  assert.deepEqual(await client.send(SEND_INPUT), transport.result);
  assert.deepEqual(transport.calls, [{ method: 'messaging.send', input: SEND_INPUT }]);
});

test('keeps @ text opaque on an ordinary thread handle instead of deriving wake authority', async () => {
  const transport = new RecordingTransport();
  const client = createMessagingClient({
    transport,
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => true },
  });
  const ordinaryDraft = {
    ...SEND_INPUT,
    address: { kind: 'thread_handle', handle: 'thread-handle-1' } as const,
    idempotencyKey: 'ordinary-plugin-message-1',
    payload: {
      ...SEND_INPUT.payload,
      elements: [
        { elementId: 'text-1', kind: 'text' as const, payload: { text: '@cat please wake' } },
      ],
    },
  };

  await client.send(ordinaryDraft);

  assert.deepEqual(transport.calls, [{ method: 'messaging.send', input: ordinaryDraft }]);
  assert.equal(
    Object.hasOwn(transport.calls[0]!.input as object, 'wake'),
    false,
    'the SDK must not synthesize wake/admission authority from package text',
  );
});

test('rejects before transport when session, grant, liveness, input, or Host result is invalid', async () => {
  const transport = new RecordingTransport();
  let state: LocalHandshakeState = { phase: 'candidate', candidate: activated().candidate };
  let live = true;
  const client = createMessagingClient({
    transport,
    getHandshakeState: () => state,
    liveness: { kind: 'stdio-session', isLive: () => live },
  });

  await assert.rejects(client.send(SEND_INPUT), error => assertClientError(error, 'SESSION_NOT_ACTIVATED'));
  state = activated([]);
  await assert.rejects(client.send(SEND_INPUT), error => assertClientError(error, 'GRANT_MISSING'));
  state = activated();
  live = false;
  await assert.rejects(client.send(SEND_INPUT), error => assertClientError(error, 'SESSION_NOT_LIVE'));
  live = true;
  await assert.rejects(
    client.send({ ...SEND_INPUT, authority: 'host' } as never),
    error => assertClientError(error, 'INVALID_INPUT'),
  );
  transport.result = { messageId: 'message-1', revision: 1 };
  await assert.rejects(client.send(SEND_INPUT), error => assertClientError(error, 'INVALID_RESULT'));
  assert.equal(transport.calls.length, 1, 'only the malformed Host result reaches transport');
});

test('maps each outbound row to its frozen grant without widening transport', async () => {
  const cases = [
    ['appendElements', 'messaging.appendElements'],
    ['subscribe', 'message.event.subscribe'],
    ['read', 'message.event.subscribe'],
    ['ack', 'message.event.subscribe'],
    ['snapshot', 'message.event.subscribe'],
  ] as const;

  for (const [method, grant] of cases) {
    const transport = new RecordingTransport();
    const client = createMessagingClient({
      transport,
      getHandshakeState: () => activated([]),
      liveness: { kind: 'stdio-session', isLive: () => true },
    });
    await assert.rejects(
      // Deliberately invalid row inputs are never reached: grant rejection is earlier.
      client[method]({} as never),
      error => {
        assertClientError(error, 'GRANT_MISSING');
        assert.match((error as Error).message, new RegExp(grant.replace('.', '\\.')));
        return true;
      },
    );
    assert.equal(transport.calls.length, 0);
  }
});
