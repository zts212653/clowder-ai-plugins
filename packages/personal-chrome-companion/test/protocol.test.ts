// v2 protocol grammar tests for p2b. The package switched from the upstream v1
// grammar (c95fd14) to the Host's frozen v2 grammar (Host 16443158ca); this is
// the only grammar the package's own helper (extension 0.2.11) speaks.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES,
  PERSONAL_CHROME_MAX_TEXT_BYTES,
  PERSONAL_CHROME_PROTOCOL_VERSION,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
  parsePersonalChromeAssistantReturnRequest,
  parsePersonalChromeAssistantReturnResult,
  parsePersonalChromeHealthResult,
  parsePersonalChromeLocalEnvelope,
} from '../src/protocol.js';

const REVISIONS = {
  helper: `sha512:${'a'.repeat(128)}`,
  extension: '0.2.11',
  pageAdapter: '2026-09-02.1',
} as const;

const appendRequest = {
  v: PERSONAL_CHROME_PROTOCOL_VERSION,
  kind: 'append_message',
  requestId: 'request-1',
  conversationId: 'conversation-1',
  text: 'hello from the Host',
  idempotencyKey: 'delivery-1',
  expectedRevisions: REVISIONS,
};

test('parses the exact v2 append request and local envelope before helper dispatch', () => {
  assert.deepEqual(parsePersonalChromeAppendRequest(appendRequest), appendRequest);
  assert.deepEqual(
    parsePersonalChromeLocalEnvelope({
      pairingSecret: 'A'.repeat(43),
      request: appendRequest,
    }),
    { pairingSecret: 'A'.repeat(43), request: appendRequest },
  );
  assert.equal(PERSONAL_CHROME_PROTOCOL_VERSION, 2);
  assert.equal(PERSONAL_CHROME_MAX_TEXT_BYTES, 128 * 1024);
  assert.equal(PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES, 256 * 1024);
});

test('rejects malformed, oversized, or v1 append messages before side effects', () => {
  const invalidRequests: unknown[] = [
    null,
    [],
    { ...appendRequest, v: 1 },
    { ...appendRequest, kind: 'stdio' },
    { ...appendRequest, text: '   ' },
    { ...appendRequest, conversationId: 'conversation/escape' },
    { ...appendRequest, text: 'é'.repeat(PERSONAL_CHROME_MAX_TEXT_BYTES) },
    // v2 requires expectedRevisions with a pinned helper artifact digest.
    { ...appendRequest, expectedRevisions: undefined },
    { ...appendRequest, expectedRevisions: { ...REVISIONS, helper: 'not-a-digest' } },
    { ...appendRequest, expectedRevisions: { ...REVISIONS, extension: '0.2' } },
    { ...appendRequest, expectedRevisions: { helper: REVISIONS.helper, extension: '0.2.11' } },
  ];
  for (const value of invalidRequests) {
    assert.throws(() => parsePersonalChromeAppendRequest(value));
  }
  assert.throws(() =>
    parsePersonalChromeLocalEnvelope({ pairingSecret: ' padded ', request: appendRequest }),
  );
  assert.throws(() =>
    parsePersonalChromeLocalEnvelope({ pairingSecret: 'A'.repeat(43), request: { ...appendRequest, v: 1 } }),
  );
});

test('accepts only correlated terminal v2 append receipts', () => {
  assert.deepEqual(
    parsePersonalChromeAppendResult({
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
      observedRevisions: REVISIONS,
      idempotentReplay: true,
    }),
    {
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
      observedRevisions: REVISIONS,
      idempotentReplay: true,
    },
  );
  assert.throws(() =>
    parsePersonalChromeAppendResult({
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
      errorCode: 'FORGED_SUCCESS',
    }),
  );
  // A successful receipt must carry the observed revisions (v2 pin check).
  assert.throws(() =>
    parsePersonalChromeAppendResult({
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'host_observed',
      hostMessageId: 'message-1',
    }),
  );
  assert.deepEqual(
    parsePersonalChromeAppendResult({
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'failed',
      errorCode: 'NEEDS_BINDING',
      observedRevisions: REVISIONS,
    }),
    {
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'failed',
      errorCode: 'NEEDS_BINDING',
      observedRevisions: REVISIONS,
    },
  );
  assert.throws(() =>
    parsePersonalChromeAppendResult({
      v: 2,
      kind: 'append_result',
      requestId: appendRequest.requestId,
      idempotencyKey: appendRequest.idempotencyKey,
      status: 'failed',
      errorCode: 'too-small',
    }),
  );
});

test('assistant-return wire requests validate the cursor all-or-nothing and ack identity', () => {
  const cursor = {
    afterConversationId: 'conversation-1',
    afterSourceMessageId: 'source-1',
    afterAssistantMessageId: 'assistant-1',
  };
  assert.deepEqual(
    parsePersonalChromeAssistantReturnRequest({
      v: 2,
      kind: 'list_assistant_returns',
      requestId: 'list-1',
      ...cursor,
    }),
    { v: 2, kind: 'list_assistant_returns', requestId: 'list-1', ...cursor },
  );
  // The v2 cursor is all-or-nothing: a partial cursor is rejected (Host h3b
  // polls one entry at a time and either pins the full cursor or none).
  assert.throws(() =>
    parsePersonalChromeAssistantReturnRequest({
      v: 2,
      kind: 'list_assistant_returns',
      requestId: 'list-1',
      afterConversationId: 'conversation-1',
    }),
  );
  assert.throws(() =>
    parsePersonalChromeAssistantReturnRequest({
      v: 2,
      kind: 'list_assistant_returns',
      requestId: 'list-1',
      afterConversationId: 'conversation-1',
      afterSourceMessageId: 'source-1',
    }),
  );
  assert.deepEqual(
    parsePersonalChromeAssistantReturnRequest({
      v: 2,
      kind: 'ack_assistant_return',
      requestId: 'ack-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      assistantMessageId: 'assistant-1',
    }),
    {
      v: 2,
      kind: 'ack_assistant_return',
      requestId: 'ack-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      assistantMessageId: 'assistant-1',
    },
  );
  assert.throws(() =>
    parsePersonalChromeAssistantReturnRequest({
      v: 2,
      kind: 'ack_assistant_return',
      requestId: 'ack-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
    }),
  );
});

test('assistant-return wire results enforce the at-most-one inbox invariant', () => {
  const entry = {
    conversationId: 'conversation-1',
    sourceMessageId: 'source-1',
    assistantMessageId: 'assistant-1',
    content: 'reply from ChatGPT',
  };
  assert.deepEqual(
    parsePersonalChromeAssistantReturnResult({
      v: 2,
      kind: 'assistant_returns',
      requestId: 'list-1',
      returns: [entry],
    }),
    { v: 2, kind: 'assistant_returns', requestId: 'list-1', returns: [entry] },
  );
  assert.throws(() =>
    parsePersonalChromeAssistantReturnResult({
      v: 2,
      kind: 'assistant_returns',
      requestId: 'list-1',
      returns: [entry, { ...entry, assistantMessageId: 'assistant-2' }],
    }),
  );
  assert.deepEqual(
    parsePersonalChromeAssistantReturnResult({
      v: 2,
      kind: 'assistant_return_ack',
      requestId: 'ack-1',
      status: 'acknowledged',
    }),
    { v: 2, kind: 'assistant_return_ack', requestId: 'ack-1', status: 'acknowledged' },
  );
  assert.deepEqual(
    parsePersonalChromeAssistantReturnResult({
      v: 2,
      kind: 'assistant_return_error',
      requestId: 'ack-1',
      errorCode: 'ASSISTANT_RETURN_NOT_FOUND',
    }),
    { v: 2, kind: 'assistant_return_error', requestId: 'ack-1', errorCode: 'ASSISTANT_RETURN_NOT_FOUND' },
  );
});

test('health_result parses the helper lifecycle statuses and drops loose error codes', () => {
  for (const status of ['ready', 'dormant', 'stale_adapter', 'failed'] as const) {
    assert.deepEqual(
      parsePersonalChromeHealthResult({
        v: 2,
        kind: 'health_result',
        requestId: 'health-1',
        status,
        observedRevisions: REVISIONS,
      }),
      { v: 2, kind: 'health_result', requestId: 'health-1', status, observedRevisions: REVISIONS },
    );
  }
  assert.throws(() =>
    parsePersonalChromeHealthResult({ v: 2, kind: 'health_result', requestId: 'health-1', status: 'unknown' }),
  );
  // errorCode is kept only when it already matches the SAFE_ERROR_CODE grammar.
  assert.deepEqual(
    parsePersonalChromeHealthResult({
      v: 2,
      kind: 'health_result',
      requestId: 'health-1',
      status: 'failed',
      errorCode: 'STALE_ADAPTER',
    }),
    { v: 2, kind: 'health_result', requestId: 'health-1', status: 'failed', errorCode: 'STALE_ADAPTER' },
  );
  assert.deepEqual(
    parsePersonalChromeHealthResult({
      v: 2,
      kind: 'health_result',
      requestId: 'health-1',
      status: 'failed',
      errorCode: 'not a code',
    }),
    { v: 2, kind: 'health_result', requestId: 'health-1', status: 'failed' },
  );
});
