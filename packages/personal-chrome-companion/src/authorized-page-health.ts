import type { OperationActionResult } from '@clowder-ai/plugin-contract';
import { isPersonalChromeConversationId, readPersonalChromeConversationAuthorizations } from '../native-host/conversation-binding.mjs';
import type { PersonalChromeConversationHostOperations } from './conversation-host.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A row supplies one exact target. Re-read membership without migrating or changing authorization. */
export function authorizedPageHealthAction(authorizationPath: string, host: PersonalChromeConversationHostOperations) {
  return async (input: unknown): Promise<OperationActionResult> => {
    const failed = (errorCode: string, label: string): OperationActionResult => ({
      render: 'status', data: { health: { status: 'failed', errorCode } }, label,
    });
    const candidate = record(input) && record(input.input) ? input.input : input;
    if (!record(candidate) || Object.keys(candidate).length !== 1 || !isPersonalChromeConversationId(candidate.conversationId)) {
      return failed('INVALID_REQUEST', 'Select one authorized conversation row to check its page.');
    }
    const conversationId = candidate.conversationId;
    try {
      const collection = await readPersonalChromeConversationAuthorizations(authorizationPath, { migrateLegacy: false });
      if (!collection.conversations.some((conversation) => conversation.conversationId === conversationId)) {
        return failed('BOUND_CONVERSATION_MISMATCH', 'This exact conversation is no longer authorized.');
      }
    } catch {
      return failed('AUTHORIZATION_INVALID', 'Conversation authorization is unavailable; no page was checked.');
    }
    const result = await host.probeConversation(conversationId);
    return { render: 'status', data: { health: result.health ?? { status: 'failed' } }, label: result.message };
  };
}
