import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import {
  validateEventsPublishInput,
  type EventsPublishInput,
} from '@clowder-ai/plugin-contract';

const STATE_VERSION = 1;
const MAX_PENDING = 512;

export type MeetingIntakeHealthStatus = 'ready' | 'auth-expired' | 'degraded';

export interface MeetingIntakeHealth {
  readonly status: MeetingIntakeHealthStatus;
  readonly code?: string;
}

export interface MeetingIntakeState {
  readonly v: typeof STATE_VERSION;
  readonly cursor: string | null;
  readonly pending: readonly EventsPublishInput[];
  readonly health: MeetingIntakeHealth;
}

export interface MeetingIntakeStateStore {
  load(): Promise<MeetingIntakeState>;
  commitPage(
    expectedCursor: string | null,
    nextCursor: string | null,
    events: readonly EventsPublishInput[],
  ): Promise<void>;
  enqueue(events: readonly EventsPublishInput[]): Promise<void>;
  acknowledge(idempotencyKey: string): Promise<void>;
  setHealth(health: MeetingIntakeHealth): Promise<void>;
}

function emptyState(): MeetingIntakeState {
  return { v: STATE_VERSION, cursor: null, pending: [], health: { status: 'ready' } };
}

function isCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 512);
}

function isHealth(value: unknown): value is MeetingIntakeHealth {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  if (Object.keys(health).some((key) => key !== 'status' && key !== 'code')) return false;
  if (!['ready', 'auth-expired', 'degraded'].includes(String(health.status))) return false;
  return health.code === undefined || (
    typeof health.code === 'string' && health.code.length >= 1 && health.code.length <= 128
  );
}

function isState(value: unknown): value is MeetingIntakeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 4 ||
    state.v !== STATE_VERSION ||
    !isCursor(state.cursor) ||
    !Array.isArray(state.pending) ||
    state.pending.length > MAX_PENDING ||
    !isHealth(state.health)
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const candidate of state.pending) {
    const validation = validateEventsPublishInput(candidate);
    if (!validation.valid || keys.has(validation.value.idempotencyKey)) return false;
    keys.add(validation.value.idempotencyKey);
  }
  return true;
}

function validatedEvents(events: readonly EventsPublishInput[]): EventsPublishInput[] {
  return events.map((candidate) => {
    const validation = validateEventsPublishInput(candidate);
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

export function createFileMeetingIntakeStateStore(path: string): MeetingIntakeStateStore {
  if (!isAbsolute(path)) throw new TypeError('meeting intake state path must be absolute');
  let state = emptyState();
  let loaded = false;
  let operations: Promise<void> = Promise.resolve();

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const candidate: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isState(candidate)) throw new Error('Feishu meeting intake state is invalid');
      state = structuredClone(candidate);
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

    commitPage(expectedCursor, nextCursor, events): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (!isCursor(nextCursor)) throw new TypeError('invalid Feishu page cursor');
        if (state.cursor !== expectedCursor) throw new Error('Feishu page cursor changed concurrently');
        await persist({
          ...state,
          cursor: nextCursor,
          pending: mergePending(state.pending, events),
        });
      });
    },

    enqueue(events): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        await persist({ ...state, pending: mergePending(state.pending, events) });
      });
    },

    acknowledge(idempotencyKey): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        const first = state.pending[0];
        if (first === undefined) return;
        if (first.idempotencyKey !== idempotencyKey) {
          throw new Error('Feishu outbox acknowledgement is not for the head event');
        }
        await persist({ ...state, pending: state.pending.slice(1) });
      });
    },

    setHealth(health): Promise<void> {
      return serialized(async () => {
        await ensureLoaded();
        if (!isHealth(health)) throw new TypeError('invalid Feishu meeting intake health');
        await persist({ ...state, health: structuredClone(health) });
      });
    },
  };
}
