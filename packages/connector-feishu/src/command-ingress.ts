import type { FeishuHostInboundMessage } from './runtime.js';

/** Provider facts only; no chat-id heuristics or payload owner authority. */
export function connectorCommandFacts(message: FeishuHostInboundMessage) {
  if (message.conversation?.type !== 'direct' && message.conversation?.type !== 'group') throw new TypeError('missing provider conversation fact');
  const sender = message.externalSenderId;
  return {
    chatId: message.externalConversationId,
    providerMessageId: message.providerMessageId,
    text: message.text,
    // The authenticated adapter owns the conversation classification.
    group: message.conversation.type === 'group',
    senderId: sender === 'unknown' || sender === '' ? undefined : sender,
  };
}
