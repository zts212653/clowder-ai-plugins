import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { parseTitleRefreshResult, type PersonalChromeTitleRefreshRequest, type PersonalChromeTitleSync } from './title-refresh-protocol.js';

import { assistantReturnCursorFields, type PersonalChromeAssistantReturnCursor } from './assistant-return-cursor.js';
import {
  PERSONAL_CHROME_EXTENSION_REVISION,
  PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES,
  PERSONAL_CHROME_PAGE_ADAPTER_REVISION,
  PERSONAL_CHROME_PROTOCOL_VERSION,
  type PersonalChromeAppendRequest,
  type PersonalChromeAppendResult,
  type PersonalChromeAssistantReturn,
  type PersonalChromeAssistantReturnRequest,
  type PersonalChromeAssistantReturnResult,
  type PersonalChromeHealthCheckRequest,
  type PersonalChromeHealthResult,
  type PersonalChromeLocalEnvelope,
  type PersonalChromeRevisions,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
  parsePersonalChromeAssistantReturnRequest,
  parsePersonalChromeAssistantReturnResult,
  parsePersonalChromeHealthResult,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class PersonalChromeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly idempotentReplay?: boolean,
    readonly diagnostic?: unknown,
  ) {
    super(message);
    this.name = 'PersonalChromeHostError';
  }
}

export interface PersonalChromeHostAdapterOptions {
  readonly socketPath: string;
  readonly pairingSecret: string;
  readonly helperArtifactRevision: string;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
  /**
   * When present, every in-flight frame exchange registers a cancel handle here
   * so a stop (Host module dispose) can destroy the socket and settle the
   * pending promise instead of leaking it until the timeout.
   */
  readonly requestTracker?: PersonalChromeHostRequestTracker;
  /** Socket facts, independent of the helper's business result/error code. */
  readonly onConnected?: () => void;
  readonly onUnavailable?: () => void;
  /** Only correlated, validated replies carry revision evidence; a socket connection does not. */
  readonly onRevisionContact?: (revisions: PersonalChromeRevisions | undefined, errorCode?: string) => Promise<void>;
}

/**
 * Tracks in-flight local-frame exchanges so a stop can cancel them: each
 * registered socket is destroyed and its pending promise settled. A request
 * already written settles as AMBIGUOUS_EFFECT (it may have been applied);
 * a not-yet-written one settles as HOST_UNAVAILABLE (ledger h3 (e)).
 */
export class PersonalChromeHostRequestTracker {
  private readonly pending = new Set<() => void>();

  /** Registers a cancel callback; returns the untrack function. */
  track(cancel: () => void): () => void {
    this.pending.add(cancel);
    return () => {
      this.pending.delete(cancel);
    };
  }

  /** Cancels every in-flight exchange. Idempotent; safe to call more than once. */
  cancelAll(): void {
    for (const cancel of [...this.pending]) cancel();
  }
}

export interface PersonalChromeAppendReceipt {
  readonly hostMessageId: string;
  readonly idempotentReplay?: boolean;
}

export interface IPersonalChromeAssistantReturnAdapter {
  list_assistant_returns(
    after?: PersonalChromeAssistantReturnCursor,
  ): Promise<readonly PersonalChromeAssistantReturn[]>;
  ack_assistant_return(conversationId: string, sourceMessageId: string, assistantMessageId: string): Promise<void>;
}

function validateOptions(options: PersonalChromeHostAdapterOptions): void {
  if (!options.socketPath || options.socketPath.trim() !== options.socketPath) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'socketPath must be a non-empty exact path');
  }
  if (options.pairingSecret.length < 32 || options.pairingSecret.length > 512) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairingSecret must contain 32-512 characters');
  }
  if (!/^sha512:[a-f0-9]{128}$/.test(options.helperArtifactRevision)) {
    throw new PersonalChromeHostError(
      'INVALID_CONFIGURATION',
      'helperArtifactRevision must be a lowercase sha512 digest',
    );
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10)) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'timeoutMs must be an integer of at least 10');
  }
}

function revisionsMatch(
  expected: PersonalChromeAppendRequest['expectedRevisions'],
  observed: PersonalChromeAppendResult['observedRevisions'],
): boolean {
  return (
    observed !== undefined &&
    observed.helper === expected.helper &&
    observed.extension === expected.extension &&
    observed.pageAdapter === expected.pageAdapter
  );
}

function exchangeLocalFrame<
  TRequest extends PersonalChromeAppendRequest | PersonalChromeAssistantReturnRequest | PersonalChromeHealthCheckRequest | PersonalChromeTitleRefreshRequest,
  TResult,
>(
  options: PersonalChromeHostAdapterOptions,
  envelope: PersonalChromeLocalEnvelope<TRequest>,
  parseResult: (value: unknown) => TResult,
): Promise<TResult> {
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
    return Promise.reject(new PersonalChromeHostError('REQUEST_TOO_LARGE', 'local append frame exceeds limit'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let settled = false;
    let input = '';
    // HOST_UNAVAILABLE promises that nothing reached the host (ledger h3 (e)). Once the request is
    // handed to the socket it may have been applied, so a later failure is ambiguous, never
    // "unavailable": the caller must not report the message as unsent.
    let requestSent = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrack();
      socket.destroy();
      callback();
    };
    // A stop (Host module dispose) cancels the exchange: a written request may
    // have been applied, so the only truthful code is AMBIGUOUS_EFFECT; before
    // the write nothing reached the host, so HOST_UNAVAILABLE stays truthful
    // (ledger h3 (e)). Never claim the message was unsent after a write.
    const cancel = (): void => {
      const error = requestSent
        ? new PersonalChromeHostError(
            'AMBIGUOUS_EFFECT',
            'personal Chrome host request was cancelled by stop after the request was sent',
          )
        : new PersonalChromeHostError(
            'HOST_UNAVAILABLE',
            'personal Chrome host request was cancelled by stop before the request was sent',
          );
      finish(() => reject(error));
    };
    const untrack = options.requestTracker?.track(cancel) ?? (() => {});
    const timer = setTimeout(() => {
      const error = requestSent
        ? new PersonalChromeHostError(
            'AMBIGUOUS_EFFECT',
            'personal Chrome host did not answer after the request was sent',
          )
        : new PersonalChromeHostError('HOST_UNAVAILABLE', 'personal Chrome host did not accept the connection');
      finish(() => reject(error));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      if (settled) return;
      requestSent = true;
      options.onConnected?.();
      socket.write(serialized);
    });
    socket.once('error', (error) => {
      if (settled) return;
      const code = (error as NodeJS.ErrnoException).code;
      if (!requestSent && (code === 'ENOENT' || code === 'ECONNREFUSED')) {
        options.onUnavailable?.();
      }
      const failure = requestSent
        ? new PersonalChromeHostError(
            'AMBIGUOUS_EFFECT',
            `personal Chrome host connection failed after the request was sent: ${error.message}`,
          )
        : new PersonalChromeHostError('HOST_UNAVAILABLE', `personal Chrome host unavailable: ${error.message}`);
      finish(() => reject(failure));
    });
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
        // Post-write failure: the request may have been applied, so the effect
        // is unknown (ledger h3 (e)) — never a receipt-level verdict.
        finish(() =>
          reject(new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'host receipt exceeds limit after the request was sent')),
        );
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      try {
        const result = parseResult(JSON.parse(input.slice(0, newline)));
        finish(() => resolve(result));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // A complete-but-invalid receipt still means the request was written:
        // AMBIGUOUS_EFFECT, never INVALID_HOST_RECEIPT (ledger h3 (e)).
        finish(() =>
          reject(new PersonalChromeHostError('AMBIGUOUS_EFFECT', `host sent an invalid receipt after the request was sent: ${detail}`)),
        );
      }
    });
    socket.once('end', () => {
      if (settled) return;
      // A graceful close after the write means the host went away without a
      // complete receipt (the response may be truncated mid-frame): the request
      // may have been applied, so this is AMBIGUOUS_EFFECT, never
      // INVALID_HOST_RECEIPT and never a bare "unavailable" claim (h3 (e)).
      const error = requestSent
        ? new PersonalChromeHostError(
            'AMBIGUOUS_EFFECT',
            'personal Chrome host closed without a receipt after the request was sent',
          )
        : new PersonalChromeHostError(
            'HOST_UNAVAILABLE',
            'personal Chrome host closed the connection before the request was sent',
          );
      finish(() => reject(error));
    });
  });
}

export class PersonalChromeHostAdapter implements IPersonalChromeAssistantReturnAdapter {
  private readonly requestId: () => string;

  constructor(private readonly options: PersonalChromeHostAdapterOptions) {
    validateOptions(options);
    this.requestId = options.requestId ?? randomUUID;
  }

  private expectedRevisions(): PersonalChromeAppendRequest['expectedRevisions'] {
    return {
      helper: this.options.helperArtifactRevision,
      extension: PERSONAL_CHROME_EXTENSION_REVISION,
      pageAdapter: PERSONAL_CHROME_PAGE_ADAPTER_REVISION,
    };
  }

  async refresh_conversation_titles(): Promise<PersonalChromeTitleSync> {
    const request: PersonalChromeTitleRefreshRequest = {
      v: 1, kind: 'refresh_conversation_titles', requestId: this.requestId(),
      expectedHelperRevision: this.options.helperArtifactRevision,
    };
    const result = await exchangeLocalFrame(this.options, { pairingSecret: this.options.pairingSecret, request },
      (value) => parseTitleRefreshResult(value, request.requestId));
    // This v1 receipt carries no extension revision: it may set a stale hint,
    // but a successful title refresh cannot prove a reload happened.
    if (result.status === 'unavailable' && result.errorCode.startsWith('STALE_')) {
      await this.options.onRevisionContact?.(undefined, result.errorCode);
    }
    return result;
  }

  async append_message(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<PersonalChromeAppendReceipt> {
    let request: PersonalChromeAppendRequest;
    try {
      request = parsePersonalChromeAppendRequest({
        v: PERSONAL_CHROME_PROTOCOL_VERSION,
        kind: 'append_message',
        requestId: this.requestId(),
        conversationId,
        text,
        idempotencyKey,
        expectedRevisions: this.expectedRevisions(),
      });
    } catch (error) {
      throw new PersonalChromeHostError('INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    }
    const result = await exchangeLocalFrame(
      this.options,
      { pairingSecret: this.options.pairingSecret, request },
      parsePersonalChromeAppendResult,
    );
    if (result.requestId !== request.requestId || result.idempotencyKey !== request.idempotencyKey) {
      // The receipt does not correlate but the request was written: the effect
      // is unknown (ledger h3 (e)).
      throw new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'host receipt does not match the append request');
    }
    if (result.status === 'failed') {
      const staleRevision =
        result.errorCode.startsWith('STALE_') ||
        (result.observedRevisions !== undefined &&
          !revisionsMatch(request.expectedRevisions, result.observedRevisions));
      await this.options.onRevisionContact?.(result.observedRevisions, staleRevision ? 'STALE_ADAPTER' : result.errorCode);
      throw new PersonalChromeHostError(
        staleRevision ? 'STALE_ADAPTER' : result.errorCode,
        staleRevision
          ? 'personal Chrome adapter revision does not match runtime'
          : `personal Chrome host failed: ${result.errorCode}`,
        result.idempotentReplay,
        result.diagnostic,
      );
    }
    if (!revisionsMatch(request.expectedRevisions, result.observedRevisions)) {
      await this.options.onRevisionContact?.(result.observedRevisions, 'STALE_ADAPTER');
      throw new PersonalChromeHostError('STALE_ADAPTER', 'personal Chrome adapter revision does not match runtime');
    }
    if (!result.hostMessageId.trim()) {
      throw new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'hostMessageId must be non-empty');
    }
    await this.options.onRevisionContact?.(result.observedRevisions);
    return {
      hostMessageId: result.hostMessageId,
      ...(result.idempotentReplay === undefined ? {} : { idempotentReplay: result.idempotentReplay }),
    };
  }

  private async exchangeAssistantReturnRequest(
    input: PersonalChromeAssistantReturnRequest,
  ): Promise<PersonalChromeAssistantReturnResult> {
    let request: PersonalChromeAssistantReturnRequest;
    try {
      request = parsePersonalChromeAssistantReturnRequest(input);
    } catch (error) {
      throw new PersonalChromeHostError('INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    }
    const result = await exchangeLocalFrame(
      this.options,
      { pairingSecret: this.options.pairingSecret, request },
      parsePersonalChromeAssistantReturnResult,
    );
    if (result.requestId !== request.requestId) {
      // Post-write receipt anomaly: the request may have been applied, so the
      // effect is unknown (ledger h3 (e)).
      throw new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'assistant return receipt does not match the request');
    }
    if (result.kind === 'assistant_return_error') {
      throw new PersonalChromeHostError(result.errorCode, `personal Chrome host failed: ${result.errorCode}`);
    }
    return result;
  }

  async list_assistant_returns(
    after?: PersonalChromeAssistantReturnCursor,
  ): Promise<readonly PersonalChromeAssistantReturn[]> {
    const result = await this.exchangeAssistantReturnRequest({
      v: PERSONAL_CHROME_PROTOCOL_VERSION,
      kind: 'list_assistant_returns',
      requestId: this.requestId(),
      ...assistantReturnCursorFields(after),
    });
    if (result.kind !== 'assistant_returns') {
      throw new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'host returned an unexpected assistant return result');
    }
    return result.returns;
  }

  async ack_assistant_return(
    conversationId: string,
    sourceMessageId: string,
    assistantMessageId: string,
  ): Promise<void> {
    const result = await this.exchangeAssistantReturnRequest({
      v: PERSONAL_CHROME_PROTOCOL_VERSION,
      kind: 'ack_assistant_return',
      requestId: this.requestId(),
      conversationId,
      sourceMessageId,
      assistantMessageId,
    });
    if (result.kind !== 'assistant_return_ack') {
      throw new PersonalChromeHostError('AMBIGUOUS_EFFECT', 'host returned an unexpected assistant return result');
    }
  }

  /**
   * Protocol-level reachability probe (health_check). Throws PersonalChromeHostError
   * for transport failures; a parsed health_result with status !== 'ready' comes back
   * as data so callers can report the reason without treating it as unreachable.
   */
  async check_health(): Promise<PersonalChromeHealthResult> {
    const request: PersonalChromeHealthCheckRequest = {
      v: PERSONAL_CHROME_PROTOCOL_VERSION,
      kind: 'health_check',
      requestId: this.requestId(),
      expectedRevisions: this.expectedRevisions(),
    };
    const result = await exchangeLocalFrame(
      this.options,
      { pairingSecret: this.options.pairingSecret, request },
      parsePersonalChromeHealthResult,
    );
    if (result.requestId !== request.requestId) {
      throw new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'health receipt does not match the probe request');
    }
    const stale = result.status === 'stale_adapter' || result.errorCode?.startsWith('STALE_') ||
      (result.observedRevisions !== undefined && !revisionsMatch(request.expectedRevisions, result.observedRevisions));
    await this.options.onRevisionContact?.(result.observedRevisions, stale ? 'STALE_ADAPTER' : result.errorCode);
    if (stale) return { ...result, status: 'stale_adapter', errorCode: 'STALE_ADAPTER' };
    return result;
  }
}
