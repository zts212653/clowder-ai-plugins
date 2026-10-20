import type { XiaoyiHostInboundMessage } from './runtime.js';

/** Provider facts only; no chat-id heuristics or payload owner authority. */
export function connectorCommandFacts(message: XiaoyiHostInboundMessage) {
  const sender = message.externalSenderId;
  return {
    chatId: message.externalConversationId,
    providerMessageId: message.providerMessageId,
    text: message.text,
    // The existing adapter supports direct conversations only; this does not enable groups.
    group: false,
    senderId: sender === 'unknown' || sender === '' ? undefined : sender,
  };
}
