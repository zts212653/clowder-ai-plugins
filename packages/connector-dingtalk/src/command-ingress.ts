import type { DingTalkHostInboundMessage } from './runtime.js';

/** Provider facts only; no chat-id heuristics or payload owner authority. */
export function connectorCommandFacts(message: DingTalkHostInboundMessage) {
  if (message.chatType !== 'p2p' && message.chatType !== 'group') throw new TypeError('missing provider conversation fact');
  const sender = message.externalSenderId;
  return {
    chatId: message.externalConversationId,
    providerMessageId: message.providerMessageId,
    text: message.text,
    // The authenticated adapter owns the conversation classification.
    group: message.chatType === 'group',
    senderId: sender === 'unknown' || sender === '' ? undefined : sender,
  };
}
