import { createHash } from 'node:crypto';

import type {
  PhysicalLimbObservation,
  PhysicalLimbTouchObservation,
  PhysicalLimbTranscriptObservation,
} from '@clowder-ai/plugin-contract';

import {
  parseStackChanTouchEventRecord,
  type ParsedStackChanTouchEvent,
} from './touch-event.js';

export {
  parseStackChanTouchEvent,
  type ParseStackChanTouchEventOptions,
} from './touch-event.js';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TRANSCRIPT_CODE_POINTS = 4_096;
const MIN_LISTEN_DURATION_MS = 100;
const MAX_LISTEN_DURATION_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 750;

export interface StackChanListenRequest {
  readonly durationMs: number;
  readonly engine: string;
  readonly language: string;
  readonly motion: 'look-up';
  readonly lookUpPitch: number;
}

export interface StackChanListenResult {
  readonly text: string;
  readonly language?: string;
  readonly durationMs: number;
}

export interface StackChanGatewayClient {
  listen(request: StackChanListenRequest): Promise<StackChanListenResult>;
  restoreSafePose(): Promise<void>;
}

export type StackChanTouchReplyResult =
  | {
      readonly status: 'completed';
      readonly interactionId: string;
      readonly transcriptObservationId?: string;
    }
  | {
      readonly status: 'ignored';
      readonly reason: 'invalid_event' | 'capture_active' | 'duplicate' | 'debounced';
    }
  | {
      readonly status: 'failed';
      readonly reason: string;
    };

export interface StackChanTouchReplyController {
  handleGatewayEvent(event: unknown): Promise<StackChanTouchReplyResult>;
}

export interface StackChanTouchReplyControllerOptions {
  readonly nodeId: string;
  readonly gateway: StackChanGatewayClient;
  readonly emitObservation: (
    observation: PhysicalLimbObservation,
  ) => void | Promise<void>;
  readonly beginInteraction?: (
    interactionId: string,
    touch: PhysicalLimbTouchObservation,
  ) => boolean | Promise<boolean>;
  readonly createId?: (
    eventKey: string,
    purpose: 'touch' | 'interaction' | 'transcript',
  ) => string;
  readonly listenDurationMs?: number;
  readonly listenEngine?: string;
  readonly language?: string;
  readonly lookUpPitch?: number;
  readonly debounceMs?: number;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'StackChan touch-to-listen failed';
}

function stableId(
  nodeId: string,
  eventKey: string,
  purpose: 'touch' | 'interaction' | 'transcript',
): string {
  const digest = createHash('sha256')
    .update(`${nodeId}\0${eventKey}\0${purpose}`)
    .digest('hex')
    .slice(0, 32);
  return `stackchan-${purpose}-${digest}`;
}

function validateListenResult(
  result: StackChanListenResult,
): StackChanListenResult | null {
  if (
    typeof result.text !== 'string' ||
    Array.from(result.text).length > MAX_TRANSCRIPT_CODE_POINTS ||
    !isFiniteInteger(result.durationMs) ||
    result.durationMs < MIN_LISTEN_DURATION_MS ||
    result.durationMs > MAX_LISTEN_DURATION_MS ||
    (result.language !== undefined &&
      (typeof result.language !== 'string' ||
        result.language.length === 0 ||
        result.language.length > 32))
  ) {
    return null;
  }
  return result;
}

export function createStackChanTouchReplyController(
  options: StackChanTouchReplyControllerOptions,
): StackChanTouchReplyController {
  const listenDurationMs = options.listenDurationMs ?? 5_000;
  const listenEngine = options.listenEngine ?? 'faster-whisper';
  const language = options.language ?? 'zh';
  const lookUpPitch = options.lookUpPitch ?? 50;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  if (
    !isIdentifier(options.nodeId) ||
    !isFiniteInteger(listenDurationMs) ||
    listenDurationMs < MIN_LISTEN_DURATION_MS ||
    listenDurationMs > MAX_LISTEN_DURATION_MS ||
    !isIdentifier(listenEngine) ||
    typeof language !== 'string' ||
    language.length === 0 ||
    language.length > 32 ||
    typeof lookUpPitch !== 'number' ||
    !Number.isFinite(lookUpPitch) ||
    lookUpPitch < 5 ||
    lookUpPitch > 85 ||
    !isFiniteInteger(debounceMs) ||
    debounceMs < 0
  ) {
    throw new TypeError('Invalid StackChan touch-reply controller configuration');
  }

  let captureActive = false;
  let lastEventKey: string | undefined;
  let lastAcceptedUnixMs: number | undefined;

  return {
    async handleGatewayEvent(event: unknown): Promise<StackChanTouchReplyResult> {
      const preliminary = parseStackChanTouchEventRecord(event, {
        nodeId: options.nodeId,
        observationId: 'stackchan-preliminary-touch',
      });
      if (preliminary === null) {
        return { status: 'ignored', reason: 'invalid_event' };
      }
      const createId =
        options.createId ??
        ((eventKey, purpose) => stableId(options.nodeId, eventKey, purpose));
      const parsed: ParsedStackChanTouchEvent = {
        ...preliminary,
        observation: {
          ...preliminary.observation,
          observationId: createId(preliminary.eventKey, 'touch'),
        },
      };
      if (captureActive) {
        return { status: 'ignored', reason: 'capture_active' };
      }
      if (parsed.eventKey === lastEventKey) {
        return { status: 'ignored', reason: 'duplicate' };
      }
      if (
        lastAcceptedUnixMs !== undefined &&
        parsed.eventUnixMs - lastAcceptedUnixMs < debounceMs
      ) {
        return { status: 'ignored', reason: 'debounced' };
      }

      const interactionId = createId(parsed.eventKey, 'interaction');
      const beganDurableInteraction =
        options.beginInteraction === undefined
          ? true
          : await options.beginInteraction(interactionId, parsed.observation);
      if (!beganDurableInteraction) {
        return { status: 'ignored', reason: 'duplicate' };
      }

      captureActive = true;
      lastEventKey = parsed.eventKey;
      lastAcceptedUnixMs = parsed.eventUnixMs;

      let listenPromise: Promise<StackChanListenResult>;
      try {
        listenPromise = options.gateway.listen({
          durationMs: listenDurationMs,
          engine: listenEngine,
          language,
          motion: 'look-up',
          lookUpPitch,
        });
      } catch (error) {
        listenPromise = Promise.reject(error);
      }

      try {
        let touchEmitError: unknown;
        try {
          if (options.beginInteraction === undefined) {
            await options.emitObservation(parsed.observation);
          }
        } catch (error) {
          touchEmitError = error;
        }

        let listenResult: StackChanListenResult | undefined;
        let listenError: unknown;
        try {
          listenResult = await listenPromise;
        } catch (error) {
          listenError = error;
        }

        let restoreError: unknown;
        try {
          await options.gateway.restoreSafePose();
        } catch (error) {
          restoreError = error;
        }

        if (listenError !== undefined) {
          const reason = errorMessage(listenError);
          return {
            status: 'failed',
            reason:
              restoreError === undefined
                ? reason
                : `${reason}; safe pose restore failed: ${errorMessage(restoreError)}`,
          };
        }
        if (restoreError !== undefined) {
          return {
            status: 'failed',
            reason: `safe pose restore failed: ${errorMessage(restoreError)}`,
          };
        }
        if (listenResult === undefined) {
          return { status: 'failed', reason: 'listen returned no result' };
        }

        if (touchEmitError !== undefined) {
          return { status: 'failed', reason: errorMessage(touchEmitError) };
        }

        const validated = validateListenResult(listenResult);
        if (validated === null) {
          return { status: 'failed', reason: 'invalid listen result' };
        }

        const text = validated.text.trim();
        if (text.length === 0) {
          return { status: 'completed', interactionId };
        }

        const transcriptObservationId = createId(parsed.eventKey, 'transcript');
        const transcript: PhysicalLimbTranscriptObservation = {
          v: 1,
          observationId: transcriptObservationId,
          nodeId: options.nodeId,
          occurredAt: new Date(
            parsed.eventUnixMs + validated.durationMs,
          ).toISOString(),
          sessionId: parsed.observation.sessionId,
          kind: 'transcript',
          payload: {
            interactionId,
            text,
            ...(validated.language === undefined
              ? {}
              : { language: validated.language }),
            captureDurationMs: validated.durationMs,
          },
        };
        await options.emitObservation(transcript);

        return {
          status: 'completed',
          interactionId,
          transcriptObservationId,
        };
      } catch (error) {
        return { status: 'failed', reason: errorMessage(error) };
      } finally {
        captureActive = false;
      }
    },
  };
}
