import assert from 'node:assert/strict';
import test from 'node:test';

import {
  METHOD_NOT_FOUND_CODE,
  METHOD_NOT_FOUND_MESSAGE,
  WIRE_METHOD_NAMES,
  validateMessagingRowInput,
  validateSessionBinding,
} from '@clowder-ai/plugin-contract';
import {
  MessagingLoopbackAdapter,
  type DecodedNdjsonFrame,
  type JsonObject,
} from '@clowder-ai/plugin-contract/conformance';

import { classifyFrame, type InFlightEntry } from './wire-dispatch.js';

const NO_IN_FLIGHT: ReadonlyMap<string, InFlightEntry> = new Map();

function requestFrame(method: string): DecodedNdjsonFrame {
  const rawFrame = JSON.stringify({
    jsonrpc: '2.0',
    id: 'connector-ingress-1',
    method,
    params: {
      meta: { deadlineUnixMs: Date.now() + 10_000 },
      input: {
        externalConversationId: 'provider-chat-42',
        providerMessageId: 'provider-message-1',
        text: 'hello from provider',
      },
    },
  });
  return {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
}

test('C1 repro: manifest-declared connector methods are not executable frozen stdio rows', () => {
  assert.ok(WIRE_METHOD_NAMES.includes('events.publish'));
  for (const method of ['telegram.inbound', 'telegram.outbound']) {
    assert.equal(WIRE_METHOD_NAMES.includes(method as never), false);
    const result = classifyFrame(requestFrame(method), NO_IN_FLIGHT);

    assert.deepEqual(result, {
      outcome: 'respond',
      disposition: 'T-F',
      response: {
        jsonrpc: '2.0',
        id: 'connector-ingress-1',
        error: {
          code: METHOD_NOT_FOUND_CODE,
          message: METHOD_NOT_FOUND_MESSAGE,
        },
      },
    });
  }
});

test('C1 repro: the closed handshake cannot project connector-binding handles', () => {
  assert.equal(validateSessionBinding({
    pluginId: 'official.connector.telegram',
    packageDigest: `sha512-${'A'.repeat(86)}==`,
    contractVersion: '0.1.0',
    wireVersion: '0.1.0',
    pluginInstanceId: 'plugin-instance-1',
    brokerSessionId: 'broker-session-1',
    grantRevision: 0,
    effectiveGrants: ['messaging.send'],
    bindingNonce: 'binding-nonce-1',
    connectorBindings: [{
      connectorId: 'telegram',
      externalConversationId: 'provider-chat-42',
      handle: 'connector-binding-opaque-1',
    }],
  }), false);
});

test('C1 repro: a provider conversation id cannot substitute for a Host-issued connector-binding handle', async () => {
  const adapter = new MessagingLoopbackAdapter();
  await adapter.setup({
    caller: { pluginInstanceId: 'plugin-instance-1' },
    grants: ['messaging.send'],
    handles: {},
    state: {},
  });

  assert.deepEqual(await adapter.execute({
    operation: 'send',
    input: {
      address: {
        kind: 'connector_binding',
        handle: 'provider-chat-42',
      },
      idempotencyKey: 'provider-message-1',
      payload: {
        provenance: {
          origin: {
            kind: 'external',
            connectorId: 'telegram',
            sourceAddress: {
              connectorId: 'telegram',
              chatId: 'provider-chat-42',
              messageId: 'provider-message-1',
            },
          },
          epistemicStatus: 'observation',
        },
        elements: [{
          elementId: 'text-1',
          kind: 'text',
          payload: { text: 'hello from provider' },
        }],
      },
    },
  }), {
    status: 'error',
    errorCode: 'NOT_FOUND',
  });
  assert.deepEqual(await adapter.observe('messages'), []);
  assert.deepEqual(await adapter.observe('output_events'), []);
  assert.deepEqual(await adapter.observe('idempotency_ledger'), []);
});

test('C1 repro: Host delivery cannot carry the provider coordinate required by connector egress', () => {
  const result = validateMessagingRowInput('host.messaging.deliver', {
    deliveryId: 'delivery-1',
    threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
    externalConversationId: 'provider-chat-42',
    envelope: {
      messageId: 'message-1',
      revision: 1,
      threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' },
      audience: { kind: 'public' },
      occurredAt: '2026-09-20T03:00:00.000Z',
      payload: {
        provenance: {
          origin: { kind: 'host' },
          epistemicStatus: 'observation',
        },
        elements: [{
          elementId: 'text-1',
          kind: 'text',
          payload: { text: 'reply from Clowder' },
        }],
      },
    },
  });

  assert.equal(result.valid, false);
  if (result.valid) assert.fail('authority-bearing provider coordinate must be rejected');
  assert.ok(result.errors.some(error => (
    error.keyword === 'additionalProperties' && error.instancePath === ''
  )));
});
