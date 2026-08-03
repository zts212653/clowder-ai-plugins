import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  PhysicalLimbObservation,
  PhysicalLimbTouchObservation,
} from '@clowder-ai/plugin-contract';

import { createFileStackChanObservationOutbox } from './observation-outbox.js';

function touch(): PhysicalLimbTouchObservation {
  return {
    v: 1,
    observationId: 'touch-1',
    nodeId: 'stackchan-home',
    occurredAt: '2026-08-01T09:10:00.000Z',
    sessionId: 'session-1',
    kind: 'touch',
    payload: { gesture: 'stroke', durationMs: 700, confidence: 1 },
  };
}

test('persists a deterministic interaction before delivery and retries it exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-outbox-'));
  const path = join(directory, 'observations.json');
  const first = createFileStackChanObservationOutbox(path);

  assert.equal(await first.beginInteraction('interaction-1', touch()), true);
  assert.equal(await first.beginInteraction('interaction-1', touch()), false);
  await assert.rejects(
    first.flush(async () => {
      throw new Error('Host unavailable');
    }),
    /Host unavailable/,
  );

  const delivered: string[] = [];
  const restarted = createFileStackChanObservationOutbox(path);
  assert.equal(
    await restarted.flush(async (observation) => {
      delivered.push(observation.observationId);
    }),
    1,
  );
  assert.deepEqual(delivered, ['touch-1']);
  assert.equal(await restarted.flush(async () => undefined), 0);
});

test('refuses a persisted observation containing raw sensor fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-outbox-'));
  const path = join(directory, 'observations.json');
  await writeFile(
    path,
    JSON.stringify({
      v: 1,
      pending: [
        {
          ...touch(),
          payload: { ...touch().payload, raw_audio: 'must-not-cross' },
        },
      ],
      seenInteractionIds: ['interaction-1'],
    }),
  );

  const outbox = createFileStackChanObservationOutbox(path);
  await assert.rejects(outbox.flush(async () => undefined), /outbox is invalid/);
});

test('rejects invalid observations at same-process mutation boundaries without delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-outbox-'));
  const outbox = createFileStackChanObservationOutbox(
    join(directory, 'observations.json'),
  );
  const rawTouch = {
    ...touch(),
    payload: { ...touch().payload, raw_audio: 'must-not-cross' },
  } as PhysicalLimbTouchObservation;
  const crossKindTouch = {
    ...touch(),
    kind: 'transcript',
    payload: {
      interactionId: 'interaction-cross-kind',
      text: 'forged transcript',
      captureDurationMs: 5_000,
    },
  } as unknown as PhysicalLimbTouchObservation;
  const crossKindObservation = {
    ...touch(),
    payload: {
      interactionId: 'interaction-cross-kind',
      text: 'forged transcript',
      captureDurationMs: 5_000,
    },
  } as unknown as PhysicalLimbObservation;

  await assert.rejects(
    outbox.beginInteraction('interaction-raw', rawTouch),
    /Invalid StackChan touch observation/,
  );
  await assert.rejects(
    outbox.beginInteraction('interaction-cross-kind', crossKindTouch),
    /Invalid StackChan touch observation/,
  );
  await assert.rejects(
    outbox.beginInteraction('', touch()),
    /Invalid StackChan interaction identifier/,
  );
  await assert.rejects(
    outbox.enqueue(rawTouch as PhysicalLimbObservation),
    /Invalid StackChan observation/,
  );
  await assert.rejects(
    outbox.enqueue(crossKindObservation),
    /Invalid StackChan observation/,
  );

  const delivered: PhysicalLimbObservation[] = [];
  assert.equal(
    await outbox.flush(async (observation) => {
      delivered.push(observation);
    }),
    0,
  );
  assert.deepEqual(delivered, []);
  assert.equal(await outbox.beginInteraction('interaction-raw', touch()), true);
});
