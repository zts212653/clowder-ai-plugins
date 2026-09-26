import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_CONVERSATION_MAX_TEXT_BYTES,
  isCloudBridgeFailureDiagnosticV1,
  isCloudConversationAckInput,
  isCloudConversationAckResult,
  isCloudConversationAppendMessageInput,
  isCloudConversationAppendMessageResult,
  isCloudConversationListInput,
  isCloudConversationListResult,
  isCloudConversationTextBudget,
} from './cloud-conversation-host.js';

const appendInput = {
  conversationId: 'conv-1',
  text: 'hello',
  idempotencyKey: 'msg-1',
};

const validFingerprint = {
  v: 1,
  phase: 'compose',
  adapterRevision: 'rev-1',
  artifactRevision: 'art-1',
  nodes: [{ path: 'composer', kind: 'element' }],
  truncated: false,
};

const validDiagnostic = {
  v: 1,
  errorCode: 'STALE_ADAPTER',
  nextAction: 'inspect_bound_tab',
  fingerprint: validFingerprint,
};

test('appendMessage input admits the frozen shape and enforces bounds both ways', () => {
  assert.equal(isCloudConversationAppendMessageInput(appendInput), true);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, conversationId: 'x'.repeat(201) }), false);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, conversationId: 'x'.repeat(200) }), true);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, conversationId: 'bad token!' }), false);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, idempotencyKey: 'x'.repeat(513) }), false);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, idempotencyKey: 'x'.repeat(512) }), true);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, text: 'x'.repeat(131073) }), false);
  assert.equal(isCloudConversationAppendMessageInput({ ...appendInput, text: '' }), false);
});

test('appendMessage result admits appended and failed shapes with providerMessageId naming', () => {
  assert.equal(
    isCloudConversationAppendMessageResult({ status: 'appended', providerMessageId: 'p-1', idempotentReplay: true }),
    true,
  );
  assert.equal(
    isCloudConversationAppendMessageResult({ status: 'appended', hostMessageId: 'p-1' }),
    false,
  );
  assert.equal(
    isCloudConversationAppendMessageResult({ status: 'failed', errorCode: 'NEEDS_BINDING', diagnostic: validDiagnostic }),
    true,
  );
  assert.equal(
    isCloudConversationAppendMessageResult({ status: 'failed', errorCode: 'needs_binding' }),
    false,
  );
  assert.equal(
    isCloudConversationAppendMessageResult({ status: 'failed', errorCode: 'AB' }),
    false,
  );
});

test('list input enforces the all-or-nothing cursor triple and list result caps at one return', () => {
  const cursor = { conversationId: 'c', sourceMessageId: 's', assistantMessageId: 'a' };
  assert.equal(isCloudConversationListInput({}), true);
  assert.equal(isCloudConversationListInput({ after: cursor }), true);
  assert.equal(isCloudConversationListInput({ after: { conversationId: 'c', sourceMessageId: 's' } }), false);
  assert.equal(isCloudConversationListInput({ after: { ...cursor, limit: 10 } }), false);
  assert.equal(isCloudConversationListInput({ limit: 10 }), false);

  const oneReturn = { ...cursor, content: 'answer' };
  assert.equal(isCloudConversationListResult({ returns: [] }), true);
  assert.equal(isCloudConversationListResult({ returns: [oneReturn] }), true);
  assert.equal(isCloudConversationListResult({ returns: [oneReturn, oneReturn] }), false);
  assert.equal(
    isCloudConversationListResult({ returns: [{ ...oneReturn, content: 'x'.repeat(131073) }] }),
    false,
  );
});

test('ack input requires the triple and ack result has acknowledged and failed shapes', () => {
  const triple = { conversationId: 'c', sourceMessageId: 's', assistantMessageId: 'a' };
  assert.equal(isCloudConversationAckInput(triple), true);
  assert.equal(isCloudConversationAckInput({ conversationId: 'c', sourceMessageId: 's' }), false);
  assert.equal(isCloudConversationAckResult({ status: 'acknowledged' }), true);
  assert.equal(isCloudConversationAckResult({ status: 'failed', errorCode: 'ASSISTANT_RETURN_NOT_FOUND' }), true);
  assert.equal(isCloudConversationAckResult({ status: 'failed', errorCode: 'assistant_return_not_found' }), false);
  assert.equal(isCloudConversationAckResult({ status: 'failed' }), false);
});

test('text budget checks UTF-8 bytes, trim, and non-string fail closed', () => {
  assert.equal(CLOUD_CONVERSATION_MAX_TEXT_BYTES, 128 * 1024);
  assert.equal(isCloudConversationTextBudget('hello'), true);
  assert.equal(isCloudConversationTextBudget('   '), false);
  assert.equal(isCloudConversationTextBudget(''), false);
  assert.equal(isCloudConversationTextBudget(null), false);
  assert.equal(isCloudConversationTextBudget(42), false);
  assert.equal(isCloudConversationTextBudget('a'.repeat(CLOUD_CONVERSATION_MAX_TEXT_BYTES)), true);
  assert.equal(isCloudConversationTextBudget('a'.repeat(CLOUD_CONVERSATION_MAX_TEXT_BYTES + 1)), false);
  // 131072 ASCII chars fit the schema bound but 65537 two-byte chars exceed the byte budget.
  assert.equal(isCloudConversationTextBudget('é'.repeat(65536)), true);
  assert.equal(isCloudConversationTextBudget('é'.repeat(65537)), false);
});

test('failure diagnostic validator matches the CloudBridgeFailureDiagnosticV1 prototype', () => {
  assert.equal(isCloudBridgeFailureDiagnosticV1(validDiagnostic), true);
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, fingerprint: { ...validFingerprint, firstUnsupportedPath: 'composer' } }),
    true,
  );

  assert.equal(isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, v: 2 }), false);
  assert.equal(isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, errorCode: 'lowercase' }), false);
  assert.equal(isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, nextAction: 'retry' }), false);
  assert.equal(isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, extra: 1 }), false);
  assert.equal(isCloudBridgeFailureDiagnosticV1({ ...validDiagnostic, fingerprint: { ...validFingerprint, nodes: 'nope' } }), false);
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({
      ...validDiagnostic,
      fingerprint: { ...validFingerprint, nodes: Array.from({ length: 13 }, () => ({ path: 'composer', kind: 'element' })) },
    }),
    false,
  );
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({
      ...validDiagnostic,
      fingerprint: { ...validFingerprint, nodes: [{ path: 'not-composer', kind: 'element' }] },
    }),
    false,
  );
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({
      ...validDiagnostic,
      fingerprint: { ...validFingerprint, nodes: [{ path: 'composer', kind: 'text', tag: 'div' }] },
    }),
    false,
  );
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({
      ...validDiagnostic,
      fingerprint: { ...validFingerprint, nodes: [{ path: 'composer', kind: 'text', tag: 'DIV' }] },
    }),
    true,
  );
  assert.equal(
    isCloudBridgeFailureDiagnosticV1({
      ...validDiagnostic,
      fingerprint: { ...validFingerprint, nodes: [{ path: 'composer', kind: 'text', childCount: 0x1_0000_0000 }] },
    }),
    false,
  );
});
