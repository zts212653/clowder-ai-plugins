/** Host-bound events.publish helper for declared C-2 signals. */

import {
  validateDeclaredEventsPublishInput,
  validateEventsPublishResult,
  type EventsPublishInput,
  type EventsPublishResult,
  type SignalDeclaration,
} from '@clowder-ai/plugin-contract';

import type { LocalHandshakeState } from './handshake-client.js';

export type EventsPublishErrorCode =
  | 'SESSION_NOT_ACTIVATED'
  | 'GRANT_MISSING'
  | 'SESSION_NOT_LIVE'
  | 'SIGNAL_UNDECLARED'
  | 'INVALID_DECLARATIONS'
  | 'INVALID_INPUT'
  | 'INVALID_RESULT';

export class EventsPublishError extends Error {
  readonly code: EventsPublishErrorCode;

  constructor(code: EventsPublishErrorCode, message: string) {
    super(message);
    this.name = 'EventsPublishError';
    this.code = code;
  }
}

export interface EventsPublishHostTransport {
  /**
   * Calls the Host Broker. The SDK deliberately supplies no codec, route,
   * credential, producer identity, or provenance field of its own.
   */
  call(method: 'events.publish', input: EventsPublishInput): Promise<unknown>;
}

export interface StdioSessionLiveness {
  readonly kind: 'stdio-session';
  /** Host/runtime-owned connection-or-lease verdict; no plugin clock math. */
  isLive(): boolean;
}

export interface EventsPublisherOptions {
  readonly transport: EventsPublishHostTransport;
  /** Contract-validated manifest signals.provides snapshot. */
  readonly declaredSignals: readonly SignalDeclaration[];
  readonly getHandshakeState: () => LocalHandshakeState;
  readonly liveness: StdioSessionLiveness;
}

export interface EventsPublisher {
  publish(input: unknown): Promise<EventsPublishResult>;
}

function requireLiveSession(options: EventsPublisherOptions): void {
  const state = options.getHandshakeState();
  if (state.phase !== 'activated') {
    throw new EventsPublishError(
      'SESSION_NOT_ACTIVATED',
      'events.publish requires an activated Host-bound session',
    );
  }
  if (!state.binding.effectiveGrants.includes('events.publish')) {
    throw new EventsPublishError(
      'GRANT_MISSING',
      'the active Host grant snapshot does not include events.publish',
    );
  }

  let live = false;
  try {
    live = options.liveness.isLive();
  } catch {
    live = false;
  }
  if (!live) {
    throw new EventsPublishError(
      'SESSION_NOT_LIVE',
      'the Host-owned stdio session liveness verdict is not live',
    );
  }
}

export function createEventsPublisher(options: EventsPublisherOptions): EventsPublisher {
  return {
    async publish(candidate: unknown): Promise<EventsPublishResult> {
      requireLiveSession(options);

      const inputValidation = validateDeclaredEventsPublishInput(
        options.declaredSignals,
        candidate,
      );
      if (!inputValidation.valid) {
        const keywords = new Set(inputValidation.errors.map(({ keyword }) => keyword));
        const code: EventsPublishErrorCode = keywords.has('declaredSignalType')
          ? 'SIGNAL_UNDECLARED'
          : keywords.has('signalDeclaration')
            ? 'INVALID_DECLARATIONS'
            : 'INVALID_INPUT';
        throw new EventsPublishError(
          code,
          `events.publish input rejected: ${inputValidation.errors
            .map(({ instancePath, message }) => `${instancePath || '/'} ${message}`)
            .join('; ')}`,
        );
      }

      // Snapshot after validation so caller mutation cannot change the value
      // while the transport is serializing it.
      const input = structuredClone(inputValidation.value);
      const result = await options.transport.call('events.publish', input);
      const resultValidation = validateEventsPublishResult(result);
      if (!resultValidation.valid) {
        throw new EventsPublishError(
          'INVALID_RESULT',
          `events.publish Host result rejected: ${resultValidation.errors
            .map(({ instancePath, message }) => `${instancePath || '/'} ${message}`)
            .join('; ')}`,
        );
      }
      return structuredClone(resultValidation.value);
    },
  };
}
