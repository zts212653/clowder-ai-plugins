import { join } from 'node:path';

import type {
  CloudConversationHostContribution,
  OperationActionResult,
  OperationRow,
} from '@clowder-ai/plugin-contract';
import {
  definePlugin,
  definePluginModule,
  operationRowAction,
  rowsResult,
  type FeatureContext,
} from '@clowder-ai/plugin-sdk';

import { createConversationHostOperations } from './conversation-host.js';
import { describeHelperConnection, type HelperConnectionStatus } from './helper-reachability.js';
import { prepareRuntimeDelivery, type RuntimeDelivery } from './runtime-delivery.js';
import {
  PERSONAL_CHROME_AUTHORIZATION_LIMIT,
  PersonalChromeConversationAuthorizationError,
  readPersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
  type PersonalChromeConversationAuthorization,
  type PersonalChromeConversationAuthorizationCollection,
} from '../native-host/conversation-binding.mjs';
import {
  projectConversationTitles,
  readConversationTitles,
  type PersonalChromeConversationTitle,
} from '../native-host/conversation-titles.mjs';

export const PERSONAL_CHROME_FEATURE_ID = 'personal-chrome-host';
export const PERSONAL_CHROME_HOST_CONTRIBUTION_ID = 'personal-chrome-chatgpt-host';
export const PERSONAL_CHROME_LIST_METHOD = 'personal-chrome-host.authorizations.list';
export const PERSONAL_CHROME_REVOKE_METHOD = 'personal-chrome-host.authorizations.revoke';
export const PERSONAL_CHROME_REFRESH_TITLES_METHOD = 'personal-chrome-host.authorizations.refresh-titles';
export const PERSONAL_CHROME_STATUS_METHOD = 'personal-chrome-host.authorizations.status';
export const PERSONAL_CHROME_TEST_METHOD = 'personal-chrome-host.test';
export const PERSONAL_CHROME_APPEND_MESSAGE_METHOD = 'personal-chrome-host.append-message';
export const PERSONAL_CHROME_ASSISTANT_LIST_METHOD = 'personal-chrome-host.assistant-returns.list';
export const PERSONAL_CHROME_ASSISTANT_ACK_METHOD = 'personal-chrome-host.assistant-returns.ack';

const REVOKE_ROW_ACTION_ID = 'revoke';
const NO_AUTHORIZATION_EMPTY_TEXT =
  'No ChatGPT conversation is authorized yet. Authorize an exact https://chatgpt.com/c/<id> conversation first.';

function deliveryGuidance(helper: HelperConnectionStatus, delivery?: RuntimeDelivery): string {
  // Loading/reloading an extension cannot repair a missing helper registration.
  if ((helper.state === 'not_installed' || helper.state === 'invalid_installation') &&
      !delivery?.status().failure) return '';
  return delivery?.label() ?? '';
}

export const personalChromeHostContribution: Omit<CloudConversationHostContribution, 'type'> = {
  id: PERSONAL_CHROME_HOST_CONTRIBUTION_ID,
  provider: 'chatgpt',
  appendMessage: { method: PERSONAL_CHROME_APPEND_MESSAGE_METHOD },
  assistantReturns: {
    list: { method: PERSONAL_CHROME_ASSISTANT_LIST_METHOD },
    ack: { method: PERSONAL_CHROME_ASSISTANT_ACK_METHOD },
  },
};

function truncateChars(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

/**
 * Maps one stored authorization to one Host-rendered row (contract h1):
 * key = conversationId, label = conversation title falling back to the id
 * (truncated to 200), detail = chatUrl (authorizedAt as defensive fallback),
 * and exactly one revoke row action carrying { conversationId } as input.
 */
export function buildAuthorizationRow(
  conversation: PersonalChromeConversationAuthorization & {
    readonly displayTitle?: string;
  },
): OperationRow {
  const label = conversation.displayTitle ?? conversation.conversationId;
  return {
    key: conversation.conversationId,
    label: truncateChars(label, 200),
    detail: conversation.chatUrl.length > 0 ? conversation.chatUrl : conversation.authorizedAt,
    actions: [operationRowAction(REVOKE_ROW_ACTION_ID, { conversationId: conversation.conversationId })],
  };
}

export function buildAuthorizationRows(
  collection: PersonalChromeConversationAuthorizationCollection,
  titles: readonly PersonalChromeConversationTitle[],
): OperationRow[] {
  return projectConversationTitles(collection.conversations, titles).map(buildAuthorizationRow);
}

export interface PersonalChromeAuthorizationOperations {
  readonly list: () => Promise<OperationActionResult>;
  readonly revoke: (input: unknown) => Promise<OperationActionResult>;
  readonly status: () => Promise<OperationActionResult>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revokeConversationId(input: unknown): string {
  if (!isObjectRecord(input)) throw new TypeError('revoke input must be an object');
  const candidate = isObjectRecord(input.input) ? input.input : input;
  const conversationId = candidate.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new TypeError('revoke input must contain a conversationId string');
  }
  return conversationId;
}

function isNeedsAuthorization(error: unknown): boolean {
  return (
    error instanceof PersonalChromeConversationAuthorizationError &&
    error.code === 'NEEDS_AUTHORIZATION'
  );
}

export function createAuthorizationOperations(options: {
  readonly authorizationPath: string;
  readonly now?: () => Date;
  readonly helperStatus?: () => HelperConnectionStatus;
  readonly delivery?: RuntimeDelivery;
}): PersonalChromeAuthorizationOperations {
  const { authorizationPath } = options;
  const now = options.now ?? (() => new Date());
  const statusResult = (data: Readonly<Record<string, unknown>>, label: string): OperationActionResult => {
    const helper = options.helperStatus?.() ?? { state: 'unknown' };
    return {
      render: 'status',
      data: { ...data, helper, ...(options.delivery ? { delivery: options.delivery.status() } : {}) },
      label: `${label} ${describeHelperConnection(helper)} ${deliveryGuidance(helper, options.delivery)}`.trim(),
    };
  };

  const readRows = async (): Promise<OperationActionResult> => {
    let collection: PersonalChromeConversationAuthorizationCollection;
    try {
      collection = await readPersonalChromeConversationAuthorizations(authorizationPath);
    } catch (error) {
      if (isNeedsAuthorization(error)) {
        return rowsResult([], { empty: NO_AUTHORIZATION_EMPTY_TEXT });
      }
      throw error;
    }
    const titles = await readConversationTitles(authorizationPath);
    return rowsResult(buildAuthorizationRows(collection, titles), {
      label: `${collection.conversations.length} authorized conversation(s)`,
    });
  };

  return {
    list: readRows,
    revoke: async (input) => {
      const conversationId = revokeConversationId(input);
      await revokePersonalChromeConversation(authorizationPath, conversationId, now().toISOString());
      return readRows();
    },
    status: async () => {
      try {
        const collection = await readPersonalChromeConversationAuthorizations(authorizationPath);
        return statusResult(
          {
            status: 'ready',
            authorizedCount: collection.conversations.length,
            authorizationLimit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
            updatedAt: collection.updatedAt,
          },
          `${collection.conversations.length}/${PERSONAL_CHROME_AUTHORIZATION_LIMIT} conversations authorized`,
        );
      } catch (error) {
        if (isNeedsAuthorization(error)) {
          return statusResult(
            {
              status: 'needs-authorization', authorizedCount: 0, authorizationLimit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
            },
            NO_AUTHORIZATION_EMPTY_TEXT,
          );
        }
        throw error;
      }
    },
  };
}

/**
 * p2b wires the three cloud-conversation-host methods to the package's own
 * native-host socket client (src/conversation-host.ts): append / list / ack go
 * over the paired Unix socket per contract beta.24 (d)/(e), and the `test`
 * action probes real helper reachability instead of reporting skeleton state.
 */
export function createConversationHostOperationsForDataDirectory(dataDirectory: string) {
  return createConversationHostOperations({ dataDirectory });
}

export function createPersonalChromePluginModule() {
  return definePluginModule((manifest) =>
    definePlugin({
      manifest,
      activate: {
        [PERSONAL_CHROME_FEATURE_ID]: async (context: FeatureContext) => {
          // Throws FeaturePermissionError (code 'PERMISSION') when the owning
          // feature is not granted the data.directory capability.
          const dataDirectory = context.dataDirectory;
          const delivery = await prepareRuntimeDelivery(dataDirectory);
          const conversationHost = createConversationHostOperations({
            dataDirectory, log: context.log, onRevisionContact: delivery.observe,
          });
          const operations = createAuthorizationOperations({
            authorizationPath: join(dataDirectory, 'conversation-binding.json'),
            helperStatus: conversationHost.status,
            delivery,
          });
          const registration = await context.conversationHosts.register(
            personalChromeHostContribution,
          );
          return {
            actions: {
              [PERSONAL_CHROME_LIST_METHOD]: operations.list,
              [PERSONAL_CHROME_REVOKE_METHOD]: operations.revoke,
              [PERSONAL_CHROME_STATUS_METHOD]: operations.status,
              [PERSONAL_CHROME_REFRESH_TITLES_METHOD]: async (): Promise<OperationActionResult> => {
                const titleSync = await conversationHost.refreshTitles();
                return {
                  render: 'status', data: { titleSync },
                  label: titleSync.status === 'synced'
                    ? `Updated ${titleSync.updatedCount} of ${titleSync.requestedCount} conversation title(s).`
                    : `Title refresh unavailable: ${titleSync.errorCode}`,
                };
              },
              [PERSONAL_CHROME_TEST_METHOD]: async () => {
                const result = await conversationHost.probe();
                const state = delivery.status();
                const helper = conversationHost.status();
                return { ok: result.ok && !state.reloadRequired && !state.failure,
                  message: `${result.message} ${describeHelperConnection(helper)} ${deliveryGuidance(helper, delivery)}`.trim() };
              },
              [PERSONAL_CHROME_APPEND_MESSAGE_METHOD]: conversationHost.appendMessage,
              [PERSONAL_CHROME_ASSISTANT_LIST_METHOD]: conversationHost.list,
              [PERSONAL_CHROME_ASSISTANT_ACK_METHOD]: conversationHost.ack,
            },
            dispose: async () => {
              await Promise.all([delivery.dispose(), conversationHost.dispose()]);
              await registration.dispose();
            },
          };
        },
      },
    }),
  );
}

export default createPersonalChromePluginModule();
