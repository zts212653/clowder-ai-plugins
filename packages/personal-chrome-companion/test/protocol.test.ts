import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES,
  PERSONAL_CHROME_MAX_TEXT_BYTES,
  PERSONAL_CHROME_PROTOCOL_VERSION,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
  parsePersonalChromeBindingRequest,
  parsePersonalChromeBindingStatus,
  parsePersonalChromeLocalEnvelope,
} from '../src/index.js';

const appendRequest = {
  v: PERSONAL_CHROME_PROTOCOL_VERSION,
  kind: 'append_message',
  requestId: 'request-1',
  conversationId: 'conversation-1',
  text: 'hello from the Host',
  idempotencyKey: 'delivery-1',
};

test('parses the exact v1 append request and local envelope before helper dispatch', () => {
  assert.deepEqual(parsePersonalChromeAppendRequest(appendRequest), appendRequest);
  assert.deepEqual(
    parsePersonalChromeLocalEnvelope({
      pairingSecret: 'A'.repeat(43),
      request: appendRequest,
    }),
    { pairingSecret: 'A'.repeat(43), request: appendRequest },
  );
  assert.equal(PERSONAL_CHROME_MAX_TEXT_BYTES, 128 * 1024);
  assert.equal(PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES, 256 * 1024);
});

test('rejects malformed, oversized, or open append messages before side effects', () => {
  const invalidRequests: unknown[] = [
    null,
    [],
    { ...appendRequest, v: 2 },
    { ...appendRequest, kind: 'stdio' },
    { ...appendRequest, text: '   ' },
    { ...appendRequest, conversationId: 'conversation/escape' },
    { ...appendRequest, unexpected: true },
    { ...appendRequest, text: 'é'.repeat(PERSONAL_CHROME_MAX_TEXT_BYTES) },
  ];
  for (const value of invalidRequests) {
    assert.throws(() => parsePersonalChromeAppendRequest(value));
  }
  assert.throws(() => parsePersonalChromeLocalEnvelope({ pairingSecret: 'short', request: appendRequest }));
});

test('accepts only correlated terminal append receipts', () => {
  assert.deepEqual(
    parsePersonalChromeAppendResult({
      v: 1,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
    }),
    {
      v: 1,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
    },
  );
  assert.throws(() =>
    parsePersonalChromeAppendResult({
      v: 1,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      errorCode: 'FORGED_SUCCESS',
    }),
  );
  assert.throws(() =>
    parsePersonalChromeAppendResult({
      v: 1,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'failed',
      errorCode: 'too-small',
    }),
  );
});

test('requires an explicit exact ChatGPT conversation for binding and validates Host status shape', () => {
  assert.deepEqual(
    parsePersonalChromeBindingRequest({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-1',
      conversationId: 'conversation-1',
      chatUrl: 'https://chatgpt.com/c/conversation-1',
    }),
    {
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-1',
      conversationId: 'conversation-1',
      chatUrl: 'https://chatgpt.com/c/conversation-1',
    },
  );
  assert.throws(() =>
    parsePersonalChromeBindingRequest({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-1',
      conversationId: 'conversation-1',
      chatUrl: 'https://chatgpt.com/c/another-conversation',
    }),
  );
  assert.deepEqual(
    parsePersonalChromeBindingStatus({
      v: 1,
      kind: 'binding_status',
      requestId: 'binding-query-1',
      status: 'unbound',
      errorCode: 'NEEDS_BINDING',
    }),
    {
      v: 1,
      kind: 'binding_status',
      requestId: 'binding-query-1',
      status: 'unbound',
      errorCode: 'NEEDS_BINDING',
    },
  );
  assert.throws(() =>
    parsePersonalChromeBindingStatus({
      v: 1,
      kind: 'binding_status',
      requestId: 'binding-query-1',
      status: 'unbound',
    }),
  );
});
