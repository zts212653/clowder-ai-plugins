import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  DELIVERY_REJECTED_CODE,
  DELIVERY_REJECTED_MESSAGE,
  DELIVERY_REJECT_REASONS,
  LIFECYCLE_REJECT_REASONS,
  classifyFrame,
  validateEffectiveGrants,
  isWireUInt53,
  type CandidateHello,
  type DeliverInput,
  type DeliveryRejectReason,
  type LifecycleRejectReason,
  type GrantSnapshot,
  type HostMessagingLifecycleInput,
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
  createEventsPublisher,
  type EventsPublisher,
  type EventsPublisherOptions,
} from './events-publisher.js';
import {
  createMessagingClient,
  type MessagingClient,
  type MessagingHostTransport,
  type OutboundMessagingMethod,
} from './messaging-client.js';
import { createMediaReader, type PluginMediaReader } from './p1-runtime.js';
import {
  createStdioChannel,
  type JsonObject,
  type StdioChannel,
  type StdioRuntimeFatalError,
} from './stdio-runtime.js';

type HostBoundPluginMethod = OutboundMessagingMethod | 'events.publish';

export type HostBoundEventPublishingOptions = Pick<
  EventsPublisherOptions,
  'declaredSignals' | 'signalSchemas'
>;

export type HostBoundMessageDisposition =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: DeliveryRejectReason };

export type HostBoundLifecycleDisposition =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: LifecycleRejectReason };

export type HostBoundMessageHandler = (
  input: DeliverInput,
) => HostBoundMessageDisposition | Promise<HostBoundMessageDisposition>;

export type HostBoundLifecycleHandler = (
  input: HostMessagingLifecycleInput,
) => HostBoundLifecycleDisposition | Promise<HostBoundLifecycleDisposition>;

export interface HostBoundSessionOptions {
  readonly claims: CandidateHello;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly eventPublishing?: HostBoundEventPublishingOptions;
  readonly onMessage?: HostBoundMessageHandler;
  readonly onLifecycle?: HostBoundLifecycleHandler;
  readonly onDrain?: (input: { readonly deadlineUnixMs: number }) => void | Promise<void>;
  readonly onGrantsChanged?: (snapshot: GrantSnapshot) => void | Promise<void>;
  readonly onFatal?: (error: Error) => void;
}

export interface HostBoundSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly state: LocalHandshakeState;
  readonly liveness: { readonly kind: 'stdio-session'; isLive(): boolean };
  readonly messaging: MessagingClient;
  readonly media: PluginMediaReader;
  readonly events: EventsPublisher | undefined;
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
const LIFECYCLE_REASONS = new Set<string>(LIFECYCLE_REJECT_REASONS);

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

function deliveryRejected(id: string, reason: LifecycleRejectReason): JsonObject {
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

function deadlineExpired(id: string): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: DEADLINE_EXPIRED_CODE,
      message: DEADLINE_EXPIRED_MESSAGE,
      data: {},
    },
  };
}

function validateGrantSnapshot(value: unknown): value is GrantSnapshot {
  return isObject(value)
    && Object.keys(value).length === 2
    && typeof value.grantRevision === 'number'
    && isWireUInt53(value.grantRevision)
    && Array.isArray(value.effectiveGrants)
    && value.effectiveGrants.every(grant => typeof grant === 'string')
    && validateEffectiveGrants(value.effectiveGrants);
}

function activatedWithGrants(state: ActivatedHandshakeState, snapshot: GrantSnapshot): ActivatedHandshakeState {
  return {
    ...state,
    binding: {
      ...state.binding,
      grantRevision: snapshot.grantRevision,
      effectiveGrants: [...snapshot.effectiveGrants],
    },
  };
}

async function completesBeforeDeadline(
  operation: (() => void | Promise<void>) | undefined,
  deadlineUnixMs: number,
  now: () => number,
): Promise<boolean> {
  if (now() >= deadlineUnixMs) return false;
  const completion = Promise.resolve().then(operation);
  while (true) {
    const remaining = deadlineUnixMs - now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const complete = await Promise.race([
        completion.then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(resolve, Math.min(remaining, 2 ** 31 - 1), false);
        }),
      ]);
      if (complete) return now() < deadlineUnixMs;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Starts one external plugin session over the signed 13-row stdio wire.
 *
 * The Host remains the sole authority for bindings, grants, liveness, message
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
    if (state.phase !== 'activated' || !state.binding.effectiveGrants.includes('onMessage')) {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host delivery arrived without active onMessage authority');
    }
    if (options.onMessage === undefined) return deliveryRejected(id, 'NO_HANDLER');
    let disposition: HostBoundMessageDisposition;
    try {
      disposition = await options.onMessage(structuredClone(input));
    } catch {
      return deliveryRejected(id, 'PLUGIN_INTERNAL');
    }
    if (!isObject(disposition) || typeof disposition.accepted !== 'boolean') {
      return deliveryRejected(id, 'PLUGIN_INTERNAL');
    }
    if (!disposition.accepted) {
      if (!DELIVERY_REASONS.has(disposition.reason)) return deliveryRejected(id, 'PLUGIN_INTERNAL');
      return deliveryRejected(id, disposition.reason);
    }
    if (Object.keys(disposition).length !== 1) return deliveryRejected(id, 'PLUGIN_INTERNAL');
    return { jsonrpc: '2.0', id, result: { deliveryId: input.deliveryId } };
  };

  const dispatchHostLifecycle = async (
    id: string,
    input: HostMessagingLifecycleInput,
  ): Promise<JsonObject> => {
    if (state.phase !== 'activated' || !state.binding.effectiveGrants.includes('onMessage')) {
      throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'Host lifecycle arrived without active onMessage authority');
    }
    if (options.onLifecycle === undefined) return deliveryRejected(id, 'NO_HANDLER');
    let disposition: HostBoundLifecycleDisposition;
    try {
      disposition = await options.onLifecycle(structuredClone(input));
    } catch {
      return deliveryRejected(id, 'PLUGIN_INTERNAL');
    }
    if (!isObject(disposition) || typeof disposition.accepted !== 'boolean') {
      return deliveryRejected(id, 'PLUGIN_INTERNAL');
    }
    if (!disposition.accepted) {
      if (!LIFECYCLE_REASONS.has(disposition.reason)) return deliveryRejected(id, 'PLUGIN_INTERNAL');
      return deliveryRejected(id, disposition.reason);
    }
    if (Object.keys(disposition).length !== 1) return deliveryRejected(id, 'PLUGIN_INTERNAL');
    return { jsonrpc: '2.0', id, result: { deliveryId: input.deliveryId } };
  };

  const dispatchRequest = async (value: JsonObject): Promise<JsonObject | undefined> => {
    const params = value.params as { meta: { deadlineUnixMs: number }; input: JsonObject };
    const method = value.method as string;
    if (method === 'host.grants.changed') {
      if (state.phase !== 'activated' || !validateGrantSnapshot(params.input)) {
        throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'invalid grants notification');
      }
      if (params.input.grantRevision <= state.binding.grantRevision) {
        throw new HostBoundSessionError('PROTOCOL_VIOLATION', 'grant revision must increase monotonically');
      }
      const snapshot = structuredClone(params.input);
      state = activatedWithGrants(state, snapshot);
      await options.onGrantsChanged?.(snapshot);
      return undefined;
    }

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
    if (method === 'host.messaging.lifecycle') {
      return dispatchHostLifecycle(id, params.input as HostMessagingLifecycleInput);
    }
    if (method === 'host.lifecycle.drain') {
      const deadlineUnixMs = params.input.deadlineUnixMs as number;
      draining = true;
      live = false;
      if (!(await completesBeforeDeadline(
        options.onDrain === undefined ? undefined : () => options.onDrain!({ deadlineUnixMs }),
        deadlineUnixMs,
        now,
      ))) {
        return deadlineExpired(id);
      }
      return { jsonrpc: '2.0', id, result: null };
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
  const media = createMediaReader(input => messaging.readMedia(input));
  const events = options.eventPublishing === undefined
    ? undefined
    : createEventsPublisher({
        transport: {
          call: (_method, input) => call('events.publish', input),
        },
        declaredSignals: options.eventPublishing.declaredSignals,
        signalSchemas: options.eventPublishing.signalSchemas,
        getHandshakeState: () => state,
        liveness,
      });

  const session: HostBoundSession = {
    ready: ready.promise,
    closed: closed.promise,
    get state() {
      return state;
    },
    liveness,
    messaging,
    media,
    events,
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
