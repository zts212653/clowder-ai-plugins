import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PhysicalLimbTouchObservation } from '@clowder-ai/plugin-contract';

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
