import type {
  PhysicalLimbObservation,
  PhysicalLimbTouchObservation,
  PhysicalLimbTranscriptObservation,
} from '@clowder-ai/plugin-contract';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TOUCH_DURATION_MS = 10_000;
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

export interface ParseStackChanTouchEventOptions {
  readonly nodeId: string;
  readonly observationId: string;
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
  readonly createId: () => string;
  readonly listenDurationMs?: number;
  readonly listenEngine?: string;
  readonly language?: string;
  readonly lookUpPitch?: number;
  readonly debounceMs?: number;
}

interface ParsedStackChanTouchEvent {
  readonly observation: PhysicalLimbTouchObservation;
  readonly eventKey: string;
  readonly eventUnixMs: number;
}

const STACKCHAN_EVENT_KEYS = new Set([
  'event_type',
  'subtype',
  'duration_ms',
  'action',
  'ts',
  'ts_unix',
  'session_id',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseTouchEvent(
  event: unknown,
  options: ParseStackChanTouchEventOptions,
): ParsedStackChanTouchEvent | null {
  if (
    !isRecord(event) ||
    Object.keys(event).some((key) => !STACKCHAN_EVENT_KEYS.has(key)) ||
    !isIdentifier(options.nodeId) ||
    !isIdentifier(options.observationId)
  ) {
    return null;
  }

  const gesture = event.subtype;
  const durationMs = event.duration_ms;
  const deviceTimestampMs = event.ts;
  const eventUnixSeconds = event.ts_unix;
  const sessionId = event.session_id;

  if (
    event.event_type !== 'touch' ||
    (gesture !== 'tap' && gesture !== 'stroke') ||
    !isFiniteInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_TOUCH_DURATION_MS ||
    !isFiniteInteger(deviceTimestampMs) ||
    deviceTimestampMs < 0 ||
    typeof eventUnixSeconds !== 'number' ||
    !Number.isFinite(eventUnixSeconds) ||
    eventUnixSeconds < 0 ||
    !isIdentifier(sessionId) ||
    (event.action !== undefined && !isIdentifier(event.action))
  ) {
    return null;
  }

  const eventUnixMs = eventUnixSeconds * 1_000;
  const occurredAt = new Date(eventUnixMs);
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  return {
    eventKey: `${sessionId}:${deviceTimestampMs}:${gesture}`,
    eventUnixMs,
    observation: {
      v: 1,
      observationId: options.observationId,
      nodeId: options.nodeId,
      occurredAt: occurredAt.toISOString(),
      sessionId,
      kind: 'touch',
      payload: {
        gesture,
        durationMs,
        confidence: 1,
      },
    },
  };
}

export function parseStackChanTouchEvent(
  event: unknown,
  options: ParseStackChanTouchEventOptions,
): PhysicalLimbTouchObservation | null {
  return parseTouchEvent(event, options)?.observation ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'StackChan touch-to-listen failed';
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
      const touchObservationId = options.createId();
      const parsed = parseTouchEvent(event, {
        nodeId: options.nodeId,
        observationId: touchObservationId,
      });
      if (parsed === null) {
        return { status: 'ignored', reason: 'invalid_event' };
      }
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

      captureActive = true;
      lastEventKey = parsed.eventKey;
      lastAcceptedUnixMs = parsed.eventUnixMs;
      const interactionId = options.createId();

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
          await options.emitObservation(parsed.observation);
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

        const transcriptObservationId = options.createId();
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
