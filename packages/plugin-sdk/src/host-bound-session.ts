import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  DELIVERY_REJECTED_CODE,
  DELIVERY_REJECTED_MESSAGE,
  DELIVERY_REJECT_REASONS,
  classifyFrame,
  isWireUInt53,
  type CandidateHello,
  isPluginDeliveryReceipt,
  type DeliverInput,
  type PluginDeliveryReceipt,
  type DeliveryRejectReason,
  type InFlightEntry,
  type MessagingRowInputByMethod,
  type MessagingRowResultByMethod,
  type RequestSnapshot,
} from '@clowder-ai/plugin-contract';

import {
  acceptSessionBinding,
  beginLocalHandshake,
  prepareActivation,
  type ActivatedHandshakeState,
  type LocalHandshakeState,
} from './handshake-client.js';
import {
  createMessagingClient,
  type MessagingClient,
  type MessagingHostTransport,
  type OutboundMessagingMethod,
} from './messaging-client.js';
import { createStreamReader } from './stream-chunks.js';
import type {PluginStreams} from './streams.js';
import {
  createStdioChannel,
  type JsonObject,
  type StdioChannel,
  type StdioRuntimeFatalError,
} from './stdio-runtime.js';

type HostBoundPluginMethod = OutboundMessagingMethod;

export type HostBoundDeliveryHandler = (
  input: DeliverInput,
) => PluginDeliveryReceipt | Promise<PluginDeliveryReceipt>;

export interface HostBoundSessionOptions {
  readonly claims: CandidateHello;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly delivery?: HostBoundDeliveryHandler;


  readonly onFatal?: (error: Error) => void;
}

export interface HostBoundSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly state: LocalHandshakeState;
  readonly liveness: { readonly kind: 'stdio-session'; isLive(): boolean };
  readonly messaging: MessagingClient;
  readonly streams: PluginStreams;
  close(): void;
}

export class HostBoundSessionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_OPTIONS'
      | 'HANDSHAKE_REJECTED'
      | 'PROTOCOL_VIOLATION'
      | 'REQUEST_FAILED'
      | 'SESSION_CLOSED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostBoundSessionError';
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

interface PendingCall {
  readonly method: HostBoundPluginMethod | 'broker.hello' | 'broker.ready';
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DELIVERY_REASONS = new Set<string>(DELIVERY_REJECT_REASONS);

function deferred<Value>(): Deferred<Value> {
  let settled = false;
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectPromise = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  return {
    promise,
    resolve: value => resolvePromise(value),
    reject: error => rejectPromise(error),
    get settled() {
      return settled;
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestSnapshot(method: HostBoundPluginMethod | 'broker.hello' | 'broker.ready', input: unknown): RequestSnapshot | undefined {
  if (!isObject(input)) return undefined;
  if (method === 'broker.hello') return { candidateHello: structuredClone(input) as unknown as CandidateHello };
  if (method === 'messaging.read') return { readLimit: input.limit as number };
  if (method === 'messaging.snapshot') return { snapshotMaxItems: input.maxItems as number };
  if (method === 'messaging.appendElements') {
    const elements = input.elements as Array<{ elementId: string }>;
    return { appendElementIds: elements.map(element => element.elementId) };
  }
  return undefined;
}

function deliveryRejected(id: string, reason: DeliveryRejectReason): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: DELIVERY_REJECTED_CODE,
      message: DELIVERY_REJECTED_MESSAGE,
      data: { reason },
    },
  };
}









/**
 * Starts one external plugin session over the signed 13-row stdio wire.
 *
 * The Host remains the sole authority for bindings, liveness, message
 * admission, retries, and delivery settlement. This helper owns only the
 * plugin-side handshake/correlation machinery and never invents an address.
 */
export function createHostBoundSession(options: HostBoundSessionOptions): HostBoundSession {
  const hasInput = options.input !== undefined;
  const hasOutput = options.output !== undefined;
  if (hasInput !== hasOutput) {
    throw new HostBoundSessionError('INVALID_OPTIONS', 'provide both input and output streams or neither');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new HostBoundSessionError('INVALID_OPTIONS', 'requestTimeoutMs must be a positive safe integer');
  }

  const initial = beginLocalHandshake(options.claims);
  if (!initial.accepted) {
    throw new HostBoundSessionError('HANDSHAKE_REJECTED', `local candidate rejected: ${initial.reason}`);
  }

  const now = options.now ?? Date.now;
  const ready = deferred<void>();
  const closed = deferred<void>();
  const pending = new Map<string, PendingCall>();
  const inFlight = new Map<string, InFlightEntry>();
  let state: LocalHandshakeState = initial.state;
  let sequence = 0;
  let live = false;
  let draining = false;
  let channel: StdioChannel;

  const closeWithError = (error: Error): void => {
    if (closed.settled) return;
    live = false;
    draining = true;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(error);
      pending.delete(id);
      inFlight.delete(id);
    }
    ready.reject(error);
    channel.close();
    closed.resolve(undefined);
    options.onFatal?.(error);
  };

  const call = <Method extends HostBoundPluginMethod | 'broker.hello' | 'broker.ready'>(
    method: Method,
    input: unknown,
  ): Promise<unknown> => {
    if (closed.settled || draining) {
      return Promise.reject(new HostBoundSessionError('SESSION_CLOSED', `${method} cannot run on a closed session`));
    }
    sequence += 1;
    const id = `plugin-call-${sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        inFlight.delete(id);
        reject(new HostBoundSessionError('REQUEST_FAILED', `${method} exceeded its request deadline`));
      }, requestTimeoutMs);
      timer.unref();
      pending.set(id, { method, resolve, reject, timer });
      const snapshot = requestSnapshot(method, input);
      inFlight.set(id, {
        method,
        ...(snapshot === undefined ? {} : { requestSnapshot: snapshot }),
      });
    });
    void channel.send({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        meta: { deadlineUnixMs: now() + requestTimeoutMs },
        input: structuredClone(input) as JsonObject,
      },
    }).catch((error: unknown) => {
      const pendingCall = pending.get(id);
      if (pendingCall === undefined) return;
      clearTimeout(pendingCall.timer);
      pending.delete(id);
      inFlight.delete(id);
      pendingCall.reject(new HostBoundSessionError('REQUEST_FAILED', `${method} write failed`, {
        cause: error,
      }));
    });
    return result;
  };

  const settleResponse = (value: JsonObject): undefined => {
    const id = value.id;
    if (typeof id !== 'string') {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host response omitted request id');
    }
    const pendingCall = pending.get(id);
    if (pendingCall === undefined) {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host response has no pending plugin call');
    }
    clearTimeout(pendingCall.timer);
    pending.delete(id);
    inFlight.delete(id);
    if ('result' in value) pendingCall.resolve(value.result);
    else pendingCall.reject(new HostBoundSessionError(
      pendingCall.method === 'broker.hello' || pendingCall.method === 'broker.ready'
        ? 'HANDSHAKE_REJECTED'
        : 'REQUEST_FAILED',
      `${pendingCall.method} rejected by Host`,
      { cause: value.error },
    ));
    return undefined;
  };

  const dispatchHostMessage = async (id: string, input: DeliverInput): Promise<JsonObject> => {
    if (state.phase !== 'activated') {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host delivery arrived before session activation');
    }
    if (options.delivery === undefined) return deliveryRejected(id, 'NO_HANDLER');
    try {
      const receipt = await options.delivery(structuredClone(input));
      if (!isPluginDeliveryReceipt(receipt) || receipt.deliveryId !== input.deliveryId) {
        return deliveryRejected(id, 'PLUGIN_INTERNAL');
      }
      return {jsonrpc: '2.0', id, result: {deliveryId: receipt.deliveryId}};
    } catch {
      return deliveryRejected(id, 'PLUGIN_INTERNAL');
    }
  };

  const dispatchRequest = async (value: JsonObject): Promise<JsonObject | undefined> => {
    const params = value.params as { meta: { deadlineUnixMs: number }; input: JsonObject };
    const method = value.method as string;


    const id = value.id;
    if (typeof id !== 'string') {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host request omitted request id');
    }
    if (method === 'host.lifecycle.ping') {
      return { jsonrpc: '2.0', id, result: { nonce: params.input.nonce } };
    }
    if (method === 'host.messaging.deliver') {
      return dispatchHostMessage(id, params.input as DeliverInput);
    }

    throw new HostBoundSessionError('PROTOCOL_VIOLATION', `unsupported Host request ${method}`);
  };

  const onFrame = async (frame: Parameters<typeof classifyFrame>[0]): Promise<JsonObject | undefined> => {
    const classification = classifyFrame(frame, inFlight);
    if (classification.outcome === 'respond') return classification.response;
    if (classification.outcome === 'close') {
      throw new HostBoundSessionError(
        'PROTOCOL_VIOLATION',
        `Host frame failed closed at ${String(classification.disposition)}`,
      );
    }
    if ('method' in frame.value) return dispatchRequest(frame.value);
    return settleResponse(frame.value);
  };

  const runtimeFatal = (error: StdioRuntimeFatalError): void => {
    const cause = error.cause instanceof Error ? error.cause : error;
    closeWithError(cause);
  };

  channel = createStdioChannel(
    options.input ?? process.stdin,
    options.output ?? process.stdout,
    { onFrame, onFatal: runtimeFatal },
  );

  const liveness = {
    kind: 'stdio-session' as const,
    isLive: () => live && !draining && !closed.settled,
  };

  const messagingTransport: MessagingHostTransport = {
    call: (method, input) => call(method, input) as Promise<MessagingRowResultByMethod[typeof method]>,
  };
  const messaging = createMessagingClient({
    transport: messagingTransport,
    getHandshakeState: () => state,
    liveness,
  });
  const streams = createStreamReader(input => messaging.readStreamChunk(input), () => {
    if (!liveness.isLive()) throw new HostBoundSessionError('SESSION_CLOSED', 'stream reader requires a live session');
  });
  const session: HostBoundSession = {
    ready: ready.promise,
    closed: closed.promise,
    get state() {
      return state;
    },
    liveness,
    messaging,
    streams,
    close: () => {
      if (closed.settled) return;
      live = false;
      draining = true;
      const error = new HostBoundSessionError('SESSION_CLOSED', 'session closed by plugin');
      for (const [id, pendingCall] of pending) {
        clearTimeout(pendingCall.timer);
        pendingCall.reject(error);
        pending.delete(id);
        inFlight.delete(id);
      }
      ready.reject(error);
      channel.close();
      closed.resolve(undefined);
    },
  };

  void (async () => {
    try {
      const binding = await call('broker.hello', options.claims);
      const bound = acceptSessionBinding(state, binding);
      if (!bound.accepted) {
        throw new HostBoundSessionError('HANDSHAKE_REJECTED', `Host binding rejected: ${bound.reason}`);
      }
      if (bound.state.phase !== 'bound') {
        throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'accepted Host binding did not enter bound state');
      }
      state = bound.state;
      const readyInput = { bindingNonce: bound.state.binding.bindingNonce };
      const readyResult = await call('broker.ready', readyInput);
      if (readyResult !== null) {
        throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'broker.ready result must be null');
      }
      const activated = prepareActivation(state, readyInput);
      if (!activated.accepted) {
        throw new HostBoundSessionError('HANDSHAKE_REJECTED', `Host activation rejected: ${activated.reason}`);
      }
      if (activated.state.phase !== 'activated') {
        throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'accepted Host activation did not enter active state');
      }
      state = activated.state;
      live = true;
      ready.resolve(undefined);
    } catch (error) {
      closeWithError(error instanceof Error ? error : new Error('Host-bound handshake failed'));
    }
  })();

  return session;
}
