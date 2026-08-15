import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';

import type { CandidateHello, SessionBinding } from '@clowder-ai/plugin-contract';
import {
  acceptSessionBinding,
  beginLocalHandshake,
  classifyFrame,
  createEventsPublisher,
  createStdioChannel,
  prepareActivation,
  type InFlightEntry,
  type JsonObject,
  type LocalHandshakeState,
  type StdioChannel,
  type StdioRuntimeFatalError,
} from '@clowder-ai/plugin-sdk';

import {
  FEISHU_MEETING_SIGNAL_DECLARATION,
  FEISHU_MEETING_SIGNAL_SCHEMAS,
} from './artifact.js';
import { FeishuGatewayError } from './gateway.js';
import {
  createLarkCliFeishuEventGateway,
  type LarkCliFeishuEventGateway,
} from './lark-cli-gateway.js';
import { meetingIntakeStatePath, readRuntimeClaims } from './runtime-claims.js';
import {
  deferred,
  FeishuStdioProtocolError,
  HostCallError,
  requestInput,
  type PendingCall,
} from './stdio-protocol.js';
import {
  createFeishuMeetingIntakeRuntime,
  type FeishuMeetingIntakeRuntime,
} from './runtime.js';
import { createFileMeetingIntakeStateStore } from './state-store.js';

const REQUEST_DEADLINE_MS = 30_000;

export interface FeishuStdioRuntimeContext {
  readonly binding: SessionBinding;
  readonly publisher: ReturnType<typeof createEventsPublisher>;
  readonly signal: AbortSignal;
}

export interface FeishuMeetingIntakeStdioOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly claims: CandidateHello;
  readonly homeDirectory?: string;
  readonly createRuntime?: (context: FeishuStdioRuntimeContext) => FeishuMeetingIntakeRuntime;
  readonly createGateway?: () => LarkCliFeishuEventGateway;
  readonly onFatal?: (error: unknown) => void;
  readonly now?: () => number;
}

export function formatFeishuRuntimeDiagnostic(error: unknown): string {
  return JSON.stringify({
    kind: 'clowder.plugin.runtime-error',
    v: 1,
    code: error instanceof FeishuGatewayError ? error.code : 'UNEXPECTED_RUNTIME_FAILURE',
  });
}

export interface FeishuMeetingIntakeStdioController {
  readonly activated: Promise<void>;
  readonly channel: StdioChannel;
  close(): Promise<void>;
}

export function startFeishuMeetingIntakeStdio(
  options: FeishuMeetingIntakeStdioOptions,
): FeishuMeetingIntakeStdioController {
  const now = options.now ?? Date.now;
  const lifecycle = new AbortController();
  const activated = deferred<void>();
  const pending = new Map<string, PendingCall>();
  const inFlight = new Map<string, InFlightEntry>();
  let requestSequence = 0;
  let handshakeState: LocalHandshakeState;
  let active = false;
  let runtimeTask: Promise<void> | undefined;
  let gateway: LarkCliFeishuEventGateway | undefined;
  let closed = false;
  let channel!: StdioChannel;

  const initial = beginLocalHandshake(options.claims);
  if (!initial.accepted) throw new TypeError('stdio runtime claims are not a valid CandidateHello');
  handshakeState = initial.state;

  const rejectPending = (error: unknown): void => {
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    inFlight.clear();
  };

  const terminate = (error: unknown): void => {
    if (closed) return;
    closed = true;
    active = false;
    lifecycle.abort(error);
    rejectPending(error);
    channel.close();
    activated.reject(error);
    options.onFatal?.(error);
    void gateway?.close();
  };

  const call = (
    method: 'broker.hello' | 'broker.ready' | 'events.publish',
    input: Record<string, unknown>,
    requestSnapshot?: InFlightEntry['requestSnapshot'],
  ): Promise<unknown> => {
    if (closed) return Promise.reject(new FeishuStdioProtocolError('stdio runtime is closed'));
    requestSequence += 1;
    const id = `f292-${requestSequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      inFlight.set(id, {
        method,
        ...(requestSnapshot === undefined ? {} : { requestSnapshot }),
      });
    });
    void channel.send({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        meta: { deadlineUnixMs: now() + REQUEST_DEADLINE_MS },
        input: structuredClone(input),
      },
    }).catch(error => terminate(error));
    return result;
  };

  const respondToHostRequest = async (value: JsonObject): Promise<JsonObject | undefined> => {
    if (value.method === 'host.grants.changed') {
      if (handshakeState.phase !== 'activated') {
        throw new FeishuStdioProtocolError('grant update arrived before activation');
      }
      const params = value.params as { input: { grantRevision: number; effectiveGrants: string[] } };
      const sameRevision = params.input.grantRevision === handshakeState.binding.grantRevision;
      const sameGrants = JSON.stringify(params.input.effectiveGrants) ===
        JSON.stringify(handshakeState.binding.effectiveGrants);
      if (!sameRevision || !sameGrants || !params.input.effectiveGrants.includes('events.publish')) {
        throw new FeishuStdioProtocolError('Host grant authority changed; restart is required');
      }
      return undefined;
    }

    const request = requestInput(value);
    if (request.method === 'host.lifecycle.ping') {
      return { jsonrpc: '2.0', id: request.id, result: { nonce: request.input.nonce } };
    }
    if (request.method === 'host.lifecycle.drain') {
      const deadlineUnixMs = request.input.deadlineUnixMs;
      if (typeof deadlineUnixMs !== 'number' || now() >= deadlineUnixMs) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32093, message: 'Deadline expired', data: {} },
        };
      }
      active = false;
      lifecycle.abort(new Error('Host requested drain'));
      await gateway?.close();
      return { jsonrpc: '2.0', id: request.id, result: null };
    }
    throw new FeishuStdioProtocolError(`unsupported accepted Host method: ${request.method}`);
  };

  channel = createStdioChannel(options.input, options.output, {
    onFrame: async frame => {
      const dispatch = classifyFrame(frame, inFlight);
      if (dispatch.outcome === 'respond') {
        if (dispatch.response === undefined) {
          throw new FeishuStdioProtocolError('classifier omitted a required response');
        }
        return dispatch.response;
      }
      if (dispatch.outcome === 'close') {
        throw new FeishuStdioProtocolError(
          `Host frame rejected as ${dispatch.disposition ?? 'unknown'}`,
        );
      }

      const value = frame.value;
      if (!('method' in value)) {
        if (typeof value.id !== 'string') {
          throw new FeishuStdioProtocolError('accepted Host response has no request id');
        }
        const call = pending.get(value.id);
        if (call === undefined) {
          throw new FeishuStdioProtocolError('accepted Host response has no pending request');
        }
        pending.delete(value.id);
        inFlight.delete(value.id);
        if ('result' in value) call.resolve(value.result);
        else call.reject(new HostCallError(call.method, value));
        return undefined;
      }
      return respondToHostRequest(value);
    },
    onFatal: error => terminate(error),
  });

  const run = async (): Promise<void> => {
    const helloResult = await call(
      'broker.hello',
      options.claims as unknown as Record<string, unknown>,
      { candidateHello: options.claims },
    );
    const bound = acceptSessionBinding(handshakeState, helloResult);
    if (!bound.accepted) throw new FeishuStdioProtocolError(`Host binding rejected: ${bound.reason}`);
    if (bound.state.phase !== 'bound') {
      throw new FeishuStdioProtocolError('Host binding did not produce the bound phase');
    }
    handshakeState = bound.state;

    if (options.createRuntime === undefined) {
      const homeDirectory = options.homeDirectory ?? homedir();
      gateway = options.createGateway?.() ?? createLarkCliFeishuEventGateway({ homeDirectory });
      await gateway.start();
    }

    const ready = { bindingNonce: bound.state.binding.bindingNonce };
    const readyResult = await call('broker.ready', ready);
    if (readyResult !== null) throw new FeishuStdioProtocolError('broker.ready result must be null');
    const activation = prepareActivation(handshakeState, ready);
    if (!activation.accepted) {
      throw new FeishuStdioProtocolError(`local activation rejected: ${activation.reason}`);
    }
    if (activation.state.phase !== 'activated') {
      throw new FeishuStdioProtocolError('broker.ready did not produce the activated phase');
    }
    const activatedState = activation.state;
    handshakeState = activatedState;
    active = true;

    const publisher = createEventsPublisher({
      transport: { call: (_method, input) => call('events.publish', input as unknown as Record<string, unknown>) },
      declaredSignals: [FEISHU_MEETING_SIGNAL_DECLARATION],
      signalSchemas: FEISHU_MEETING_SIGNAL_SCHEMAS,
      getHandshakeState: () => handshakeState,
      liveness: { kind: 'stdio-session', isLive: () => active && !channel.failed },
    });
    const runtime = options.createRuntime?.({
      binding: activatedState.binding,
      publisher,
      signal: lifecycle.signal,
    }) ?? (() => {
      const homeDirectory = options.homeDirectory ?? homedir();
      if (gateway === undefined) {
        throw new FeishuStdioProtocolError('Feishu event gateway was not started before activation');
      }
      return createFeishuMeetingIntakeRuntime({
        gateway,
        publisher,
        store: createFileMeetingIntakeStateStore(
          meetingIntakeStatePath(homeDirectory, activatedState.binding.pluginInstanceId),
        ),
      });
    })();

    activated.resolve();
    runtimeTask = (async () => {
      while (active && !lifecycle.signal.aborted) {
        await runtime.pollOnce(lifecycle.signal);
      }
    })();
    await runtimeTask;
  };
  void run().catch(error => terminate(error));

  return {
    channel,
    activated: activated.promise,
    close: async () => {
      if (closed) return;
      closed = true;
      active = false;
      const reason = new Error('stdio runtime closed');
      lifecycle.abort(reason);
      rejectPending(reason);
      activated.reject(reason);
      channel.close();
      await gateway?.close();
      if (runtimeTask !== undefined) {
        await Promise.race([
          runtimeTask.catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 1_000)),
        ]);
      }
    },
  };
}

export function runFeishuMeetingIntakeEntrypoint(): FeishuMeetingIntakeStdioController {
  const controller = startFeishuMeetingIntakeStdio({
    input: process.stdin,
    output: process.stdout,
    claims: readRuntimeClaims(process.env),
    onFatal: (error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`${formatFeishuRuntimeDiagnostic(error)}\n`);
    },
  });
  void controller.activated.catch(() => undefined);
  return controller;
}

export { meetingIntakeStatePath, readRuntimeClaims } from './runtime-claims.js';
