import type { EventsPublishInput } from '@clowder-ai/plugin-contract';

import { validateFeishuMeetingPublishInput } from './artifact.js';

export const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;
export const MAX_PENDING = 512;

export type MeetingIntakeHealthStatus = 'ready' | 'auth-expired' | 'degraded';

export interface MeetingIntakeHealth {
  readonly status: MeetingIntakeHealthStatus;
  readonly code?: string;
  readonly lastCycleAt: number | null;
  readonly lastSuccessfulObservationAt: number | null;
  readonly lastPublishedAt: number | null;
}

export interface MeetingIntakeHealthUpdate {
  readonly status: MeetingIntakeHealthStatus;
  readonly code?: string;
}

export interface CatchUpResolution {
  readonly action: 'future-only' | 'replay';
  readonly fromCursor: string | null;
  readonly throughCursor: string;
  readonly candidateCount: number;
  readonly resolvedAt: number;
}

export type MeetingIntakeCatchUp =
  | { readonly status: 'idle'; readonly lastResolution?: CatchUpResolution }
  | {
      readonly status: 'needs-owner';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly detectedAt: number;
    }
  | {
      readonly status: 'previewed';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly candidateCount: number;
      readonly fingerprint: string;
      readonly previewedAt: number;
    }
  | {
      readonly status: 'backlog';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly candidateCountAtLeast: number;
      readonly reason: 'PAGE_BOUND' | 'CANDIDATE_BOUND';
      readonly detectedAt: number;
    };

export interface MeetingIntakeState {
  readonly v: typeof STATE_VERSION;
  readonly cursor: string | null;
  readonly pending: readonly EventsPublishInput[];
  readonly health: MeetingIntakeHealth;
  readonly catchUp: MeetingIntakeCatchUp;
}

export function emptyState(): MeetingIntakeState {
  return {
    v: STATE_VERSION,
    cursor: null,
    pending: [],
    health: {
      status: 'ready',
      lastCycleAt: null,
      lastSuccessfulObservationAt: null,
      lastPublishedAt: null,
    },
    catchUp: { status: 'idle' },
  };
}

export function isCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 512);
}

function isTimestamp(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

export function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

export function isHealthUpdate(value: unknown): value is MeetingIntakeHealthUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  if (Object.keys(health).some((key) => key !== 'status' && key !== 'code')) return false;
  if (!['ready', 'auth-expired', 'degraded'].includes(String(health.status))) return false;
  return health.code === undefined || (
    typeof health.code === 'string' && health.code.length >= 1 && health.code.length <= 128
  );
}

function isHealth(value: unknown): value is MeetingIntakeHealth {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  if (
    Object.keys(health).some((key) => ![
      'status', 'code', 'lastCycleAt', 'lastSuccessfulObservationAt', 'lastPublishedAt',
    ].includes(key)) ||
    !isHealthUpdate({ status: health.status, ...(health.code === undefined ? {} : { code: health.code }) })
  ) return false;
  return isTimestamp(health.lastCycleAt) &&
    isTimestamp(health.lastSuccessfulObservationAt) &&
    isTimestamp(health.lastPublishedAt);
}

function isResolution(value: unknown): value is CatchUpResolution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const resolution = value as Record<string, unknown>;
  return Object.keys(resolution).every((key) => [
    'action', 'fromCursor', 'throughCursor', 'candidateCount', 'resolvedAt',
  ].includes(key)) &&
    ['future-only', 'replay'].includes(String(resolution.action)) &&
    isCursor(resolution.fromCursor) &&
    typeof resolution.throughCursor === 'string' &&
    isCursor(resolution.throughCursor) &&
    Number.isSafeInteger(resolution.candidateCount) &&
    (resolution.candidateCount as number) >= 0 &&
    isTimestamp(resolution.resolvedAt) && resolution.resolvedAt !== null;
}

export function isCatchUp(value: unknown): value is MeetingIntakeCatchUp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const catchUp = value as Record<string, unknown>;
  if (catchUp.status === 'idle') {
    return Object.keys(catchUp).every((key) => ['status', 'lastResolution'].includes(key)) &&
      (catchUp.lastResolution === undefined || isResolution(catchUp.lastResolution));
  }
  if (!isCursor(catchUp.fromCursor) || typeof catchUp.throughCursor !== 'string') return false;
  if (catchUp.status === 'needs-owner') {
    return Object.keys(catchUp).every((key) => [
      'status', 'fromCursor', 'throughCursor', 'detectedAt',
    ].includes(key)) && isTimestamp(catchUp.detectedAt) && catchUp.detectedAt !== null;
  }
  if (catchUp.status === 'previewed') {
    return Object.keys(catchUp).every((key) => [
      'status', 'fromCursor', 'throughCursor', 'candidateCount', 'fingerprint', 'previewedAt',
    ].includes(key)) &&
      Number.isSafeInteger(catchUp.candidateCount) && (catchUp.candidateCount as number) >= 0 &&
      typeof catchUp.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(catchUp.fingerprint) &&
      isTimestamp(catchUp.previewedAt) && catchUp.previewedAt !== null;
  }
  if (catchUp.status === 'backlog') {
    return Object.keys(catchUp).every((key) => [
      'status', 'fromCursor', 'throughCursor', 'candidateCountAtLeast', 'reason', 'detectedAt',
    ].includes(key)) &&
      Number.isSafeInteger(catchUp.candidateCountAtLeast) &&
      (catchUp.candidateCountAtLeast as number) >= 1 &&
      ['PAGE_BOUND', 'CANDIDATE_BOUND'].includes(String(catchUp.reason)) &&
      isTimestamp(catchUp.detectedAt) && catchUp.detectedAt !== null;
  }
  return false;
}

function validPending(value: unknown): value is readonly EventsPublishInput[] {
  if (!Array.isArray(value) || value.length > MAX_PENDING) return false;
  const keys = new Set<string>();
  for (const candidate of value) {
    const validation = validateFeishuMeetingPublishInput(candidate);
    if (!validation.valid || keys.has(validation.value.idempotencyKey)) return false;
    keys.add(validation.value.idempotencyKey);
  }
  return true;
}

export function isState(value: unknown): value is MeetingIntakeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 5 &&
    state.v === STATE_VERSION &&
    isCursor(state.cursor) && validPending(state.pending) &&
    isHealth(state.health) && isCatchUp(state.catchUp);
}

export function migrateLegacyState(value: unknown): MeetingIntakeState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const legacy = value as Record<string, unknown>;
  if (
    Object.keys(legacy).length !== 4 || legacy.v !== LEGACY_STATE_VERSION ||
    !isCursor(legacy.cursor) || !validPending(legacy.pending) || !isHealthUpdate(legacy.health)
  ) return undefined;
  const health = legacy.health;
  return {
    v: STATE_VERSION,
    cursor: legacy.cursor,
    pending: structuredClone(legacy.pending),
    health: {
      ...structuredClone(health),
      lastCycleAt: null,
      lastSuccessfulObservationAt: null,
      lastPublishedAt: null,
    },
    catchUp: { status: 'idle' },
  };
}
