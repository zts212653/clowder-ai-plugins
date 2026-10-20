import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCommandFacts } from './command-ingress.js';
import type { DingTalkHostInboundMessage } from './runtime.js';

const message: DingTalkHostInboundMessage = { externalConversationId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', externalSenderId: 'admin', chatType: 'p2p', providerConversationId: 'c' };
test('dingtalk command normalization preserves explicit provider identity and event key', () => {
  assert.deepEqual(connectorCommandFacts(message), { chatId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', group: false, senderId: 'admin' });
});
test('dingtalk group policy follows provider conversation facts, never identifier shape', () => {
  const group = { ...message, chatType: 'group' as const };
  assert.equal(connectorCommandFacts(group).group, true);
  assert.throws(() => connectorCommandFacts({ ...message, chatType: undefined } as unknown as DingTalkHostInboundMessage), /conversation/);
});
