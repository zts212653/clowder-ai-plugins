/** Plugin-to-Host helpers for the six frozen outbound M0-C messaging rows. */

import {
  validateMessagingRowInput,
  validateMessagingRowResult,
  type MessagingRowInputByMethod,
  type MessagingRowMethod,
  type MessagingRowResultByMethod,
} from '@clowder-ai/plugin-contract';

import type { LocalHandshakeState } from './handshake-client.js';
import type { StdioSessionLiveness } from './events-publisher.js';

export type OutboundMessagingMethod = Exclude<
  MessagingRowMethod,
  'host.messaging.deliver' | 'host.messaging.lifecycle'
>;

export type MessagingClientErrorCode =
  | 'SESSION_NOT_ACTIVATED'
  | 'GRANT_MISSING'
  | 'SESSION_NOT_LIVE'
  | 'INVALID_INPUT'
  | 'INVALID_RESULT';

export class MessagingClientError extends Error {
  readonly code: MessagingClientErrorCode;

  constructor(code: MessagingClientErrorCode, message: string) {
    super(message);
    this.name = 'MessagingClientError';
    this.code = code;
  }
}

export interface MessagingHostTransport {
  /** Calls one frozen plugin-to-Host messaging row on the active Broker session. */
  call<Method extends OutboundMessagingMethod>(
    method: Method,
    input: MessagingRowInputByMethod[Method],
  ): Promise<MessagingRowResultByMethod[Method]>;
}

export interface MessagingClientOptions {
  readonly transport: MessagingHostTransport;
  readonly getHandshakeState: () => LocalHandshakeState;
  readonly liveness: StdioSessionLiveness;
}

export interface MessagingClient {
  send(input: MessagingRowInputByMethod['messaging.send']): Promise<MessagingRowResultByMethod['messaging.send']>;
  appendElements(input: MessagingRowInputByMethod['messaging.appendElements']): Promise<MessagingRowResultByMethod['messaging.appendElements']>;
  subscribe(input: MessagingRowInputByMethod['messaging.subscribe']): Promise<MessagingRowResultByMethod['messaging.subscribe']>;
  read(input: MessagingRowInputByMethod['messaging.read']): Promise<MessagingRowResultByMethod['messaging.read']>;
  ack(input: MessagingRowInputByMethod['messaging.ack']): Promise<MessagingRowResultByMethod['messaging.ack']>;
  snapshot(input: MessagingRowInputByMethod['messaging.snapshot']): Promise<MessagingRowResultByMethod['messaging.snapshot']>;
  readMedia(input: MessagingRowInputByMethod['media.read']): Promise<MessagingRowResultByMethod['media.read']>;
}

const GRANT_BY_METHOD = {
  'messaging.send': 'messaging.send',
  'messaging.appendElements': 'messaging.appendElements',
  'messaging.subscribe': 'message.event.subscribe',
  'messaging.read': 'message.event.subscribe',
  'messaging.ack': 'message.event.subscribe',
  'messaging.snapshot': 'message.event.subscribe',
  'media.read': 'media.read',
} as const satisfies Readonly<Record<OutboundMessagingMethod, string>>;

function validationMessage(
  prefix: string,
  errors: readonly { readonly instancePath: string; readonly message: string }[],
): string {
  return `${prefix}: ${errors
    .map(({ instancePath, message }) => `${instancePath || '/'} ${message}`)
    .join('; ')}`;
}

function requireUsableSession(options: MessagingClientOptions, method: OutboundMessagingMethod): void {
  const state = options.getHandshakeState();
  if (state.phase !== 'activated') {
    throw new MessagingClientError(
      'SESSION_NOT_ACTIVATED',
      `${method} requires an activated Host-bound session`,
    );
  }

  const grant = GRANT_BY_METHOD[method];
  if (!state.binding.effectiveGrants.includes(grant)) {
    throw new MessagingClientError(
      'GRANT_MISSING',
      `the active Host grant snapshot does not include ${grant}`,
    );
  }

  let live = false;
  try {
    live = options.liveness.isLive();
  } catch {
    live = false;
  }
  if (!live) {
    throw new MessagingClientError(
      'SESSION_NOT_LIVE',
      'the Host-owned stdio session liveness verdict is not live',
    );
  }
}

async function callValidated<Method extends OutboundMessagingMethod>(
  options: MessagingClientOptions,
  method: Method,
  candidate: unknown,
): Promise<MessagingRowResultByMethod[Method]> {
  requireUsableSession(options, method);

  const inputValidation = validateMessagingRowInput(method, candidate);
  if (!inputValidation.valid) {
    throw new MessagingClientError(
      'INVALID_INPUT',
      validationMessage(`${method} input rejected`, inputValidation.errors),
    );
  }

  const input = structuredClone(inputValidation.value);
  const result = await options.transport.call(method, input);
  const resultValidation = validateMessagingRowResult(method, result);
  if (!resultValidation.valid) {
    throw new MessagingClientError(
      'INVALID_RESULT',
      validationMessage(`${method} Host result rejected`, resultValidation.errors),
    );
  }
  return structuredClone(resultValidation.value);
}

export function createMessagingClient(options: MessagingClientOptions): MessagingClient {
  return {
    send: input => callValidated(options, 'messaging.send', input),
    appendElements: input => callValidated(options, 'messaging.appendElements', input),
    subscribe: input => callValidated(options, 'messaging.subscribe', input),
    read: input => callValidated(options, 'messaging.read', input),
    ack: input => callValidated(options, 'messaging.ack', input),
    snapshot: input => callValidated(options, 'messaging.snapshot', input),
    readMedia: input => callValidated(options, 'media.read', input),
  };
}
