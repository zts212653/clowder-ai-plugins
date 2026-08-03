import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import type {
  PhysicalLimbObservation,
  PhysicalLimbTouchObservation,
} from '@clowder-ai/plugin-contract';
import { isPhysicalLimbObservation } from './physical-limb-validator.js';

const OUTBOX_VERSION = 1;
const MAX_PENDING_OBSERVATIONS = 256;
const MAX_SEEN_INTERACTIONS = 1_024;

interface StackChanObservationOutboxState {
  v: typeof OUTBOX_VERSION;
  pending: PhysicalLimbObservation[];
  seenInteractionIds: string[];
}

export interface StackChanObservationOutbox {
  beginInteraction(
    interactionId: string,
    touch: PhysicalLimbTouchObservation,
  ): Promise<boolean>;
  enqueue(observation: PhysicalLimbObservation): Promise<void>;
  flush(
    deliver: (observation: PhysicalLimbObservation) => Promise<unknown>,
  ): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isState(value: unknown): value is StackChanObservationOutboxState {
  return Boolean(
    isRecord(value) &&
      Object.keys(value).length === 3 &&
      value.v === OUTBOX_VERSION &&
      Array.isArray(value.pending) &&
      value.pending.length <= MAX_PENDING_OBSERVATIONS &&
      value.pending.every(isPhysicalLimbObservation) &&
      new Set(
        value.pending.map((observation) =>
          (observation as PhysicalLimbObservation).observationId,
        ),
      ).size === value.pending.length &&
      Array.isArray(value.seenInteractionIds) &&
      value.seenInteractionIds.length <= MAX_SEEN_INTERACTIONS &&
      value.seenInteractionIds.every(isIdentifier) &&
      new Set(value.seenInteractionIds).size === value.seenInteractionIds.length,
  );
}

function emptyState(): StackChanObservationOutboxState {
  return { v: OUTBOX_VERSION, pending: [], seenInteractionIds: [] };
}

export function createFileStackChanObservationOutbox(
  path: string,
): StackChanObservationOutbox {
  if (!isAbsolute(path)) {
    throw new TypeError('observation outbox path must be absolute');
  }

  let loaded = false;
  let state = emptyState();
  let operations: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    if (loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isState(raw)) {
        throw new Error('StackChan observation outbox is invalid');
      }
      state = structuredClone(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    loaded = true;
  }

  async function save(): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation, operation);
    operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    beginInteraction(interactionId, touch): Promise<boolean> {
      return serialized(async () => {
        if (!isIdentifier(interactionId)) {
          throw new TypeError('Invalid StackChan interaction identifier');
        }
        if (!isPhysicalLimbObservation(touch) || touch.kind !== 'touch') {
          throw new TypeError('Invalid StackChan touch observation');
        }
        await load();
        if (state.seenInteractionIds.includes(interactionId)) return false;
        if (state.pending.length >= MAX_PENDING_OBSERVATIONS) {
          throw new Error('StackChan observation outbox is full');
        }
        const shiftedInteractionId =
          state.seenInteractionIds.length === MAX_SEEN_INTERACTIONS
            ? state.seenInteractionIds[0]
            : undefined;
        state.seenInteractionIds.push(interactionId);
        if (state.seenInteractionIds.length > MAX_SEEN_INTERACTIONS) {
          state.seenInteractionIds.shift();
        }
        state.pending.push(structuredClone(touch));
        try {
          await save();
        } catch (error) {
          state.pending.pop();
          state.seenInteractionIds.pop();
          if (shiftedInteractionId !== undefined) {
            state.seenInteractionIds.unshift(shiftedInteractionId);
          }
          throw error;
        }
        return true;
      });
    },

    enqueue(observation): Promise<void> {
      return serialized(async () => {
        if (!isPhysicalLimbObservation(observation)) {
          throw new TypeError('Invalid StackChan observation');
        }
        await load();
        if (
          state.pending.some(
            (pending) => pending.observationId === observation.observationId,
          )
        ) {
          return;
        }
        if (state.pending.length >= MAX_PENDING_OBSERVATIONS) {
          throw new Error('StackChan observation outbox is full');
        }
        state.pending.push(structuredClone(observation));
        try {
          await save();
        } catch (error) {
          state.pending.pop();
          throw error;
        }
      });
    },

    flush(deliver): Promise<number> {
      return serialized(async () => {
        await load();
        let delivered = 0;
        while (state.pending.length > 0) {
          const observation = state.pending[0];
          if (observation === undefined) break;
          await deliver(structuredClone(observation));
          state.pending.shift();
          delivered += 1;
          try {
            await save();
          } catch (error) {
            state.pending.unshift(observation);
            throw error;
          }
        }
        return delivered;
      });
    },
  };
}
