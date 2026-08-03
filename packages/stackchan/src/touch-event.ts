import type { PhysicalLimbTouchObservation } from '@clowder-ai/plugin-contract';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TOUCH_DURATION_MS = 10_000;

export interface ParseStackChanTouchEventOptions {
  readonly nodeId: string;
  readonly observationId: string;
}

export interface ParsedStackChanTouchEvent {
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

export function parseStackChanTouchEventRecord(
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
  if (Number.isNaN(occurredAt.getTime())) return null;

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
      payload: { gesture, durationMs, confidence: 1 },
    },
  };
}

export function parseStackChanTouchEvent(
  event: unknown,
  options: ParseStackChanTouchEventOptions,
): PhysicalLimbTouchObservation | null {
  return parseStackChanTouchEventRecord(event, options)?.observation ?? null;
}
