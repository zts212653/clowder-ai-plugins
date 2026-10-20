import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCommandFacts } from './command-ingress.js';
import type { FeishuHostInboundMessage } from './runtime.js';

const message: FeishuHostInboundMessage = { externalConversationId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', externalSenderId: 'admin', conversation: { type: 'direct' } };
test('feishu command normalization preserves explicit provider identity and event key', () => {
  assert.deepEqual(connectorCommandFacts(message), { chatId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', group: false, senderId: 'admin' });
});
test('feishu group policy follows provider conversation facts, never identifier shape', () => {
  const group = { ...message, conversation: { type: 'group' as const } };
  assert.equal(connectorCommandFacts(group).group, true);
  assert.throws(() => connectorCommandFacts({ ...message, conversation: undefined } as unknown as FeishuHostInboundMessage), /conversation/);
});
