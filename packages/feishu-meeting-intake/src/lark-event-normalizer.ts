import { createHash } from 'node:crypto';

import type { FeishuGeneratedArtifact } from './gateway.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MINUTE_EVENT_KEYS = new Set([
  'type',
  'event_id',
  'timestamp',
  'minute_token',
  'title',
  'minute_source',
]);
const NOTE_EVENT_KEYS = new Set([
  'type',
  'event_id',
  'timestamp',
  'note_id',
  'note_token',
  'verbatim_token',
  'note_source',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireClosedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`lark-cli event contains forbidden field: ${key}`);
  }
}

function requireSafeId(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a bounded opaque identifier`);
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new TypeError('lark-cli event timestamp must be a positive millisecond token');
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError('lark-cli event timestamp is outside the safe integer range');
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.valueOf())) throw new TypeError('lark-cli event timestamp is invalid');
  return date.toISOString();
}

function requireOptionalTitle(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) {
    throw new TypeError('lark-cli event title must be at most 512 characters');
  }
  return value;
}

function requireMeetingId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  requireClosedKeys(value, new Set(['source_type', 'source_entity_id']));
  if (value.source_type !== 'meeting') {
    throw new TypeError(`${label}.source_type must be meeting when present`);
  }
  return requireSafeId(value.source_entity_id, `${label}.source_entity_id`, 128);
}

function revisionFromEventId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new TypeError('lark-cli event_id must be a bounded string');
  }
  return value.length <= 64 && SAFE_ID.test(value)
    ? value
    : createHash('sha256').update(value, 'utf8').digest('hex');
}

export function readLarkCliEventId(value: unknown): string {
  if (!isRecord(value)) throw new TypeError('lark-cli event must be an object');
  return requireSafeId(value.event_id, 'event_id', 512);
}

export function normalizeLarkCliGeneratedEvent(value: unknown): FeishuGeneratedArtifact {
  if (!isRecord(value)) throw new TypeError('lark-cli event must be an object');
  const revision = revisionFromEventId(value.event_id);
  const generatedAt = requireTimestamp(value.timestamp);
  if (value.type === 'minutes.minute.generated_v1') {
    requireClosedKeys(value, MINUTE_EVENT_KEYS);
    const meetingId = requireMeetingId(value.minute_source, 'minute_source');
    const title = requireOptionalTitle(value.title);
    return {
      artifactId: requireSafeId(value.minute_token, 'minute_token', 128),
      kind: 'minute',
      revision,
      generatedAt,
      ...(title === undefined ? {} : { title }),
      ...(meetingId === undefined ? {} : { meetingId }),
    };
  }
  if (value.type === 'vc.note.generated_v1') {
    requireClosedKeys(value, NOTE_EVENT_KEYS);
    const meetingId = requireMeetingId(value.note_source, 'note_source');
    if (value.note_token !== undefined && typeof value.note_token !== 'string') {
      throw new TypeError('note_token must be a string when present');
    }
    if (value.verbatim_token !== undefined && typeof value.verbatim_token !== 'string') {
      throw new TypeError('verbatim_token must be a string when present');
    }
    return {
      artifactId: requireSafeId(value.note_id, 'note_id', 128),
      kind: 'note',
      revision,
      generatedAt,
      ...(meetingId === undefined ? {} : { meetingId }),
    };
  }
  throw new TypeError('lark-cli event type is not a generated meeting artifact');
}
