import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import type { EventsPublishInput } from '@clowder-ai/plugin-contract';

import { validateFeishuMeetingPublishInput } from './artifact.js';
import {
  MAX_PENDING,
  emptyState,
  isCatchUp,
  isCursor,
  isHealthUpdate,
  isState,
  migrateLegacyState,
  requireTimestamp,
  type MeetingIntakeCatchUp,
  type MeetingIntakeHealth,
  type MeetingIntakeHealthUpdate,
  type MeetingIntakeState,
} from './state-model.js';

export type {
  CatchUpResolution,
  MeetingIntakeCatchUp,
  MeetingIntakeHealth,
  MeetingIntakeHealthStatus,
  MeetingIntakeHealthUpdate,
  MeetingIntakeState,
} from './state-model.js';

export interface MeetingIntakeStateStore {
  load(): Promise<MeetingIntakeState>;
  commitPage(
    expectedCursor: string | null,
    nextCursor: string | null,
    events: readonly EventsPublishInput[],
    observedAt: number,
  ): Promise<void>;
  enqueue(events: readonly EventsPublishInput[]): Promise<void>;
  acknowledge(idempotencyKey: string, publishedAt: number): Promise<void>;
  setHealth(health: MeetingIntakeHealthUpdate): Promise<void>;
  requireCatchUp(input: {
    readonly fromCursor: string | null;
    readonly throughCursor: string;
    readonly reason: 'CURSOR_GAP' | 'PAGE_BOUND' | 'CANDIDATE_BOUND';
    readonly candidateCountAtLeast?: number;
    readonly detectedAt: number;
  }): Promise<void>;
  recordCatchUpPreview(input: {
    readonly candidateCount: number;
    readonly fingerprint: string;
    readonly previewedAt: number;
  }): Promise<void>;
  resolveCatchUpFutureOnly(fingerprint: string, resolvedAt: number): Promise<void>;
  resolveCatchUpReplay(
    fingerprint: string,
    events: readonly EventsPublishInput[],
    resolvedAt: number,
  ): Promise<void>;
}

function validatedEvents(events: readonly EventsPublishInput[]): EventsPublishInput[] {
  return events.map((candidate) => {
    const validation = validateFeishuMeetingPublishInput(candidate);
    if (!validation.valid) throw new TypeError('refusing to persist an invalid signal');
    return structuredClone(validation.value);
  });
}

function mergePending(
  current: readonly EventsPublishInput[],
  incoming: readonly EventsPublishInput[],
): EventsPublishInput[] {
  const merged = current.map((event) => structuredClone(event));
  const byKey = new Map(merged.map((event) => [event.idempotencyKey, event]));
  for (const event of validatedEvents(incoming)) {
    const existing = byKey.get(event.idempotencyKey);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`conflicting signal for idempotency key ${event.idempotencyKey}`);
      }
      continue;
    }
    merged.push(event);
    byKey.set(event.idempotencyKey, event);
  }
  if (merged.length > MAX_PENDING) throw new Error('Feishu meeting intake outbox is full');
  return merged;
}

function withoutHealthCode(health: MeetingIntakeHealth): Omit<MeetingIntakeHealth, 'code'> {
  const { code: _code, ...rest } = health;
  return rest;
}

export function createFileMeetingIntakeStateStore(path: string): MeetingIntakeStateStore {
  if (!isAbsolute(path)) throw new TypeError('meeting intake state path must be absolute');
  let state = emptyState();
  let loaded = false;
  let operations: Promise<void> = Promise.resolve();

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const candidate: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (isState(candidate)) state = structuredClone(candidate);
      else {
        const migrated = migrateLegacyState(candidate);
        if (migrated === undefined) throw new Error('Feishu meeting intake state is invalid');
        state = migrated;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    loaded = true;
  }

  async function persist(next: MeetingIntakeState): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    state = structuredClone(next);
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    load(): Promise<MeetingIntakeState> {
      return serialized(async () => {
        await ensureLoaded();
        return structuredClone(state);
      });
    },

    commitPage(expectedCursor, nextCursor, events, observedAt): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (!isCursor(nextCursor)) throw new TypeError('invalid Feishu page cursor');
        requireTimestamp(observedAt, 'observation timestamp');
        if (
          state.health.lastSuccessfulObservationAt !== null &&
          observedAt < state.health.lastSuccessfulObservationAt
        ) {
          throw new Error('Feishu observation timestamp regressed');
        }
        if (state.cursor !== expectedCursor) throw new Error('Feishu page cursor changed concurrently');
        await persist({
          ...state,
          cursor: nextCursor,
          pending: mergePending(state.pending, events),
          health: {
            ...withoutHealthCode(state.health),
            status: 'ready',
            lastCycleAt: observedAt,
            lastSuccessfulObservationAt: observedAt,
          },
        });
      });
    },

    enqueue(events): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        await persist({ ...state, pending: mergePending(state.pending, events) });
      });
    },

    acknowledge(idempotencyKey, publishedAt): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        requireTimestamp(publishedAt, 'publication timestamp');
        if (state.health.lastPublishedAt !== null && publishedAt < state.health.lastPublishedAt) {
          throw new Error('Feishu publication timestamp regressed');
        }
        const first = state.pending[0];
        if (first === undefined) return;
        if (first.idempotencyKey !== idempotencyKey) {
          throw new Error('Feishu outbox acknowledgement is not for the head event');
        }
        await persist({
          ...state,
          pending: state.pending.slice(1),
          health: { ...state.health, lastCycleAt: publishedAt, lastPublishedAt: publishedAt },
        });
      });
    },

    setHealth(health): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (!isHealthUpdate(health)) throw new TypeError('invalid Feishu meeting intake health');
        await persist({
          ...state,
          health: health.code === undefined
            ? { ...withoutHealthCode(state.health), status: health.status }
            : { ...state.health, ...structuredClone(health) },
        });
      });
    },

    requireCatchUp(input): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (!isCursor(input.fromCursor) || typeof input.throughCursor !== 'string' ||
          !isCursor(input.throughCursor)) {
          throw new TypeError('invalid Feishu catch-up window');
        }
        requireTimestamp(input.detectedAt, 'catch-up detection timestamp');
        const catchUp: MeetingIntakeCatchUp = input.reason === 'CURSOR_GAP'
          ? {
              status: 'needs-owner',
              fromCursor: input.fromCursor,
              throughCursor: input.throughCursor,
              detectedAt: input.detectedAt,
            }
          : {
              status: 'backlog',
              fromCursor: input.fromCursor,
              throughCursor: input.throughCursor,
              candidateCountAtLeast: input.candidateCountAtLeast ?? 1,
              reason: input.reason,
              detectedAt: input.detectedAt,
            };
        if (!isCatchUp(catchUp)) throw new TypeError('invalid Feishu catch-up state');
        await persist({
          ...state,
          catchUp,
          health: { ...state.health, status: 'degraded', code: 'CATCH_UP_REQUIRED' },
        });
      });
    },

    recordCatchUpPreview(input): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (state.catchUp.status !== 'needs-owner' && state.catchUp.status !== 'previewed') {
          throw new Error('Feishu catch-up does not need an owner preview');
        }
        requireTimestamp(input.previewedAt, 'catch-up preview timestamp');
        const next: MeetingIntakeCatchUp = {
          status: 'previewed',
          fromCursor: state.catchUp.fromCursor,
          throughCursor: state.catchUp.throughCursor,
          candidateCount: input.candidateCount,
          fingerprint: input.fingerprint,
          previewedAt: input.previewedAt,
        };
        if (!isCatchUp(next)) throw new TypeError('invalid Feishu catch-up preview');
        await persist({ ...state, catchUp: next });
      });
    },

    resolveCatchUpFutureOnly(fingerprint, resolvedAt): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        requireTimestamp(resolvedAt, 'catch-up resolution timestamp');
        if (state.catchUp.status !== 'previewed' || state.catchUp.fingerprint !== fingerprint) {
          throw new Error('Feishu catch-up preview changed');
        }
        const preview = state.catchUp;
        await persist({
          ...state,
          cursor: preview.throughCursor,
          catchUp: {
            status: 'idle',
            lastResolution: {
              action: 'future-only',
              fromCursor: preview.fromCursor,
              throughCursor: preview.throughCursor,
              candidateCount: preview.candidateCount,
              resolvedAt,
            },
          },
          health: {
            ...withoutHealthCode(state.health),
            status: 'ready',
            lastCycleAt: resolvedAt,
          },
        });
      });
    },

    resolveCatchUpReplay(fingerprint, events, resolvedAt): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        requireTimestamp(resolvedAt, 'catch-up resolution timestamp');
        if (state.catchUp.status !== 'previewed' || state.catchUp.fingerprint !== fingerprint) {
          throw new Error('Feishu catch-up preview changed');
        }
        const preview = state.catchUp;
        const pending = mergePending(state.pending, events);
        if (events.length !== preview.candidateCount) {
          throw new Error('Feishu catch-up candidate count changed');
        }
        await persist({
          ...state,
          cursor: preview.throughCursor,
          pending,
          catchUp: {
            status: 'idle',
            lastResolution: {
              action: 'replay',
              fromCursor: preview.fromCursor,
              throughCursor: preview.throughCursor,
              candidateCount: preview.candidateCount,
              resolvedAt,
            },
          },
          health: {
            ...withoutHealthCode(state.health),
            status: 'ready',
            lastCycleAt: resolvedAt,
            lastSuccessfulObservationAt: resolvedAt,
          },
        });
      });
    },
  };
}
