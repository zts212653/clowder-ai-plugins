import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCommandFacts } from './command-ingress.js';
import type { WeComBotHostInboundMessage } from './runtime.js';

const message: WeComBotHostInboundMessage = { externalConversationId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', sender: { id: 'admin' }, conversation: { type: 'direct' } };
test('wecom-bot command normalization preserves explicit provider identity and event key', () => {
  assert.deepEqual(connectorCommandFacts(message), { chatId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', group: false, senderId: 'admin' });
});
test('wecom-bot group policy follows provider conversation facts, never identifier shape', () => {
  const group = { ...message, conversation: { type: 'group' as const } };
  assert.equal(connectorCommandFacts(group).group, true);
  assert.throws(() => connectorCommandFacts({ ...message, conversation: undefined } as unknown as WeComBotHostInboundMessage), /conversation/);
});
