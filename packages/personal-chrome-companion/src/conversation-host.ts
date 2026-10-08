import {
  type CloudBridgeFailureDiagnosticV1,
  type CloudConversationAckResult,
  type CloudConversationAppendMessageResult,
  type CloudConversationListResult,
  isCloudBridgeFailureDiagnosticV1,
  isCloudConversationAckInput,
  isCloudConversationAppendMessageInput,
} from '@clowder-ai/plugin-contract';

import {
  createPersonalChromeHostAdapter,
  isPersonalChromeNotInstalled,
  readPersonalChromeAdapterOptions,
} from './pairing-record.js';
import { PersonalChromeHostError, PersonalChromeHostRequestTracker, type PersonalChromeHostAdapterOptions } from './personal-chrome-host-transport.js';
import type { PersonalChromeAssistantReturnCursor } from './assistant-return-cursor.js';
import { HelperReachability, type HelperConnectionLog, type HelperConnectionStatus } from './helper-reachability.js';
import type { PersonalChromeTitleSync } from './title-refresh-protocol.js';

export interface PersonalChromeConversationHostOperations {
  readonly refreshTitles: () => Promise<PersonalChromeTitleSync>;
  readonly appendMessage: (input: unknown) => Promise<CloudConversationAppendMessageResult>;
  readonly list: (input: unknown) => Promise<CloudConversationListResult>;
  readonly ack: (input: unknown) => Promise<CloudConversationAckResult>;
  /** Honest reachability probe for the `test` action: never claims ok without a real probe. */
  readonly probe: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  /** Last-known connection state; never opens a socket or reads the pairing record. */
  readonly status: () => HelperConnectionStatus;
  readonly dispose: () => Promise<void>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asContractDiagnostic(diagnostic: unknown): Record<string, unknown> {
  return isCloudBridgeFailureDiagnosticV1(diagnostic) ? { diagnostic } : {};
}

function appendFailure(
  errorCode: string,
  extras: Readonly<Record<string, unknown>> = {},
): CloudConversationAppendMessageResult {
  return { status: 'failed', errorCode, ...extras } as CloudConversationAppendMessageResult;
}

function ackFailure(errorCode: string, extras: Readonly<Record<string, unknown>> = {}): CloudConversationAckResult {
  return { status: 'failed', errorCode, ...extras } as CloudConversationAckResult;
}

/**
 * Resolves the pairing record from the granted data directory. A missing record
 * is one of the three (e) cases and maps to HOST_UNAVAILABLE; a corrupt record is
 * INVALID_CONFIGURATION. Both are PersonalChromeHostError codes passed through.
 */
async function resolveAdapterOptions(
  dataDirectory: string,
  onNotInstalled: () => void,
  onInvalidConfiguration: () => void,
): Promise<PersonalChromeHostAdapterOptions> {
  try {
    return await readPersonalChromeAdapterOptions(dataDirectory);
  } catch (error) {
    if (isPersonalChromeNotInstalled(error)) {
      onNotInstalled();
      throw new PersonalChromeHostError('HOST_UNAVAILABLE', 'personal Chrome host is not installed');
    }
    if (error instanceof PersonalChromeHostError && error.code === 'INVALID_CONFIGURATION') {
      onInvalidConfiguration();
    }
    throw error;
  }
}

function toCursor(value: unknown): PersonalChromeAssistantReturnCursor | undefined {
  if (!isObjectRecord(value)) return undefined;
  const { conversationId, sourceMessageId, assistantMessageId } = value;
  if (
    typeof conversationId !== 'string' ||
    typeof sourceMessageId !== 'string' ||
    typeof assistantMessageId !== 'string'
  ) {
    return undefined;
  }
  return { conversationId, sourceMessageId, assistantMessageId };
}

/**
 * The three cloud-conversation-host methods (contract beta.24 h3) backed by the
 * package's own native-host socket client. None of these throw: the Host treats
 * any throw after the call as AMBIGUOUS_EFFECT, so every failure is returned as
 * data per the (d) error-code table and every result passes the contract
 * validators with no extra fields.
 */
export function createConversationHostOperations(options: {
  readonly dataDirectory: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly log?: HelperConnectionLog;
  readonly onRevisionContact?: PersonalChromeHostAdapterOptions['onRevisionContact'];
}): PersonalChromeConversationHostOperations {
  const { dataDirectory } = options;
  let disposed = false;
  // Cancels every in-flight helper request on stop: dispose destroys their
  // sockets and settles the pending promises (written ones as AMBIGUOUS_EFFECT)
  // instead of leaking them until their timeouts (ledger h3 (e)).
  const requestTracker = new PersonalChromeHostRequestTracker();
  const reachability = new HelperReachability(options.now ?? Date.now, options.log);
  const unavailable = (state: 'unreachable' | 'not_installed'): void => {
    if (!disposed) reachability.unavailable(state);
  };
  const adapterOptionsForRequest = async (): Promise<PersonalChromeHostAdapterOptions> => ({
    ...(await resolveAdapterOptions(
      dataDirectory,
      () => unavailable('not_installed'),
      () => { if (!disposed) reachability.invalidInstallation(); },
    )),
    timeoutMs: options.timeoutMs,
    requestTracker,
    onConnected: () => { if (!disposed) reachability.connected(); },
    onUnavailable: () => unavailable('unreachable'),
    onRevisionContact: async (revisions, errorCode) => {
      if (!disposed) await options.onRevisionContact?.(revisions, errorCode);
    },
  });

  const appendMessage = async (input: unknown): Promise<CloudConversationAppendMessageResult> => {
    if (disposed) return appendFailure('HOST_UNAVAILABLE');
    if (!isCloudConversationAppendMessageInput(input)) {
      return appendFailure('INVALID_REQUEST');
    }
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = await adapterOptionsForRequest();
    } catch (error) {
      if (error instanceof PersonalChromeHostError) return appendFailure(error.code);
      return appendFailure('AMBIGUOUS_EFFECT');
    }
    // Stop may have run while the pairing record was being read: no socket has
    // been created yet, so nothing was sent and HOST_UNAVAILABLE stays truthful
    // (cancelAll alone cannot cover requests that register after it returns).
    if (disposed) return appendFailure('HOST_UNAVAILABLE');
    try {
      const receipt = await createPersonalChromeHostAdapter(adapterOptions).append_message(
        input.conversationId,
        input.text,
        input.idempotencyKey,
      );
      return {
        status: 'appended',
        providerMessageId: receipt.hostMessageId,
        ...(receipt.idempotentReplay === undefined ? {} : { idempotentReplay: receipt.idempotentReplay }),
      };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        return appendFailure(error.code, {
          ...asContractDiagnostic(error.diagnostic),
          ...(error.idempotentReplay === undefined ? {} : { idempotentReplay: error.idempotentReplay }),
        });
      }
      // The request may have reached the helper; without a typed code the only
      // truthful answer is "effect unknown" (ledger h3 (e)).
      return appendFailure('AMBIGUOUS_EFFECT');
    }
  };

  const list = async (input: unknown): Promise<CloudConversationListResult> => {
    if (disposed || !reachability.canList()) return { returns: [] };
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = await adapterOptionsForRequest();
    } catch {
      // Invalid installation is visible in status but does not start backoff.
      // Only missing installation or a pre-send socket failure gates list.
      return { returns: [] };
    }
    // Stop during pairing resolution: nothing sent yet, report an empty round.
    if (disposed) return { returns: [] };
    try {
      const after = toCursor(isObjectRecord(input) ? input.after : undefined);
      const returns = await createPersonalChromeHostAdapter(adapterOptions).list_assistant_returns(after);
      return { returns: [...returns] };
    } catch {
      return { returns: [] };
    }
  };

  const ack = async (input: unknown): Promise<CloudConversationAckResult> => {
    if (disposed) return ackFailure('HOST_UNAVAILABLE');
    if (!isCloudConversationAckInput(input)) {
      return ackFailure('INVALID_REQUEST');
    }
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = await adapterOptionsForRequest();
    } catch (error) {
      if (error instanceof PersonalChromeHostError) return ackFailure(error.code);
      return ackFailure('AMBIGUOUS_EFFECT');
    }
    // Stop during pairing resolution: no socket created, nothing was sent.
    if (disposed) return ackFailure('HOST_UNAVAILABLE');
    try {
      await createPersonalChromeHostAdapter(adapterOptions).ack_assistant_return(
        input.conversationId,
        input.sourceMessageId,
        input.assistantMessageId,
      );
      return { status: 'acknowledged' };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        // ASSISTANT_RETURN_NOT_FOUND means the return is already settled; pass it
        // through so the Host stops retrying that entry.
        return ackFailure(error.code, asContractDiagnostic(error.diagnostic));
      }
      return ackFailure('AMBIGUOUS_EFFECT');
    }
  };

  const probe = async (): Promise<{ readonly ok: boolean; readonly message: string }> => {
    if (disposed) return { ok: false, message: 'personal Chrome host module is stopped' };
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = await adapterOptionsForRequest();
    } catch (error) {
      if (error instanceof PersonalChromeHostError && error.code === 'HOST_UNAVAILABLE') {
        return { ok: false, message: 'personal Chrome host is not installed (no pairing record)' };
      }
      if (error instanceof PersonalChromeHostError) {
        return { ok: false, message: `personal Chrome pairing record rejected: ${error.code}` };
      }
      return { ok: false, message: 'personal Chrome pairing record is unreadable' };
    }
    // Stop during pairing resolution: never probe after stop returned.
    if (disposed) return { ok: false, message: 'personal Chrome host module is stopped' };
    try {
      const health = await createPersonalChromeHostAdapter(adapterOptions).check_health();
      if (health.status === 'ready') {
        return { ok: true, message: 'personal Chrome host helper answered the health probe' };
      }
      const reason = health.errorCode ?? health.status;
      return { ok: false, message: `personal Chrome host health probe reported ${reason}` };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        return { ok: false, message: `personal Chrome host is not reachable: ${error.code}` };
      }
      return { ok: false, message: 'personal Chrome host health probe failed unexpectedly' };
    }
  };

  // Owner-triggered, like probe: deliberately bypasses the background list gate.
  const refreshTitles = async (): Promise<PersonalChromeTitleSync> => {
    if (disposed) return { status: 'unavailable', errorCode: 'HOST_UNAVAILABLE' };
    try {
      const adapterOptions = await adapterOptionsForRequest();
      if (disposed) return { status: 'unavailable', errorCode: 'HOST_UNAVAILABLE' };
      return await createPersonalChromeHostAdapter(adapterOptions).refresh_conversation_titles();
    } catch (error) {
      return { status: 'unavailable', errorCode: error instanceof PersonalChromeHostError ? error.code : 'AMBIGUOUS_EFFECT' };
    }
  };

  return {
    refreshTitles,
    appendMessage,
    list,
    ack,
    probe,
    status: () => reachability.snapshot(),
    dispose: async () => {
      disposed = true;
      reachability.reset();
      requestTracker.cancelAll();
    },
  };
}
