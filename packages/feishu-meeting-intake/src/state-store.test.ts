import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EventsPublishInput } from '@clowder-ai/plugin-contract';

import {
  createFileMeetingIntakeStateStore,
  normalizeGeneratedArtifact,
} from './index.js';

const EVENT: EventsPublishInput = normalizeGeneratedArtifact({
  artifactId: 'om_state_1',
  kind: 'minute',
  revision: '1',
  generatedAt: '2026-08-23T08:00:00Z',
  title: 'State migration meeting',
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-intake-state-'));
  return join(directory, 'state.json');
}

test('migrates v1 state in memory without losing cursor, pending outbox, or typed health', async () => {
  const path = await statePath();
  await writeFile(path, `${JSON.stringify({
    v: 1,
    cursor: 'poll-v1:1786954302512',
    pending: [EVENT],
    health: { status: 'degraded', code: 'PUBLISH_FAILED' },
  })}\n`);

  const store = createFileMeetingIntakeStateStore(path);

  assert.deepEqual(await store.load(), {
    v: 2,
    cursor: 'poll-v1:1786954302512',
    pending: [EVENT],
    health: {
      status: 'degraded',
      code: 'PUBLISH_FAILED',
      lastCycleAt: null,
      lastSuccessfulObservationAt: null,
      lastPublishedAt: null,
    },
    catchUp: { status: 'idle' },
  });

  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.v, 1, 'read-only migration must not rewrite owner state');
});

test('commits source observation before publication and records settlement only after acknowledgement', async () => {
  const path = await statePath();
  const store = createFileMeetingIntakeStateStore(path);

  await store.commitPage(null, 'poll-v1:2000', [EVENT], 2_000);
  assert.deepEqual((await store.load()).health, {
    status: 'ready',
    lastCycleAt: 2_000,
    lastSuccessfulObservationAt: 2_000,
    lastPublishedAt: null,
  });
  assert.equal((await store.load()).pending.length, 1);

  await store.acknowledge(EVENT.idempotencyKey, 2_100);
  const settled = await store.load();
  assert.equal(settled.pending.length, 0);
  assert.equal(settled.health.lastPublishedAt, 2_100);
  assert.equal(settled.health.lastSuccessfulObservationAt, 2_000);
});

test('rejects non-monotonic observation and publication timestamps', async () => {
  const store = createFileMeetingIntakeStateStore(await statePath());
  await store.commitPage(null, 'poll-v1:2000', [EVENT], 2_000);
  await store.acknowledge(EVENT.idempotencyKey, 2_100);

  await assert.rejects(
    store.commitPage('poll-v1:2000', 'poll-v1:3000', [], 1_999),
    /observation timestamp regressed/,
  );
  await store.enqueue([EVENT]);
  await assert.rejects(
    store.acknowledge(EVENT.idempotencyKey, 2_099),
    /publication timestamp regressed/,
  );
});

test('persists a frozen owner decision window and preview without advancing cursor or outbox', async () => {
  const store = createFileMeetingIntakeStateStore(await statePath());
  await store.commitPage(null, 'poll-v1:1000', [], 1_000);
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  await store.recordCatchUpPreview({
    candidateCount: 1,
    fingerprint: 'a'.repeat(64),
    previewedAt: 5_200,
  });

  const previewed = await store.load();
  assert.equal(previewed.cursor, 'poll-v1:1000');
  assert.deepEqual(previewed.pending, []);
  assert.deepEqual(previewed.catchUp, {
    status: 'previewed',
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    candidateCount: 1,
    fingerprint: 'a'.repeat(64),
    previewedAt: 5_200,
  });
});

test('requires the preview fence before atomically replaying into the durable outbox', async () => {
  const store = createFileMeetingIntakeStateStore(await statePath());
  await store.requireCatchUp({
    fromCursor: null,
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  await store.recordCatchUpPreview({
    candidateCount: 1,
    fingerprint: 'a'.repeat(64),
    previewedAt: 5_200,
  });

  await assert.rejects(
    store.resolveCatchUpReplay('b'.repeat(64), [EVENT], 5_300),
    /preview changed/,
  );
  assert.equal((await store.load()).cursor, null);
  assert.deepEqual((await store.load()).pending, []);

  await store.resolveCatchUpReplay('a'.repeat(64), [EVENT], 5_300);
  const replayed = await store.load();
  assert.equal(replayed.cursor, 'poll-v1:5000');
  assert.deepEqual(replayed.pending, [EVENT]);
  assert.deepEqual(replayed.catchUp, {
    status: 'idle',
    lastResolution: {
      action: 'replay',
      fromCursor: null,
      throughCursor: 'poll-v1:5000',
      candidateCount: 1,
      resolvedAt: 5_300,
    },
  });
});

test('future-only explicitly skips the previewed window without publishing it', async () => {
  const store = createFileMeetingIntakeStateStore(await statePath());
  await store.requireCatchUp({
    fromCursor: null,
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  await store.recordCatchUpPreview({
    candidateCount: 3,
    fingerprint: 'c'.repeat(64),
    previewedAt: 5_200,
  });
  await store.resolveCatchUpFutureOnly('c'.repeat(64), 5_300);

  const skipped = await store.load();
  assert.equal(skipped.cursor, 'poll-v1:5000');
  assert.deepEqual(skipped.pending, []);
  assert.equal(skipped.catchUp.status, 'idle');
  assert.equal(skipped.catchUp.lastResolution?.action, 'future-only');
});

test('turns bounded collection overflow into durable backlog truth', async () => {
  const store = createFileMeetingIntakeStateStore(await statePath());
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'PAGE_BOUND',
    candidateCountAtLeast: 121,
    detectedAt: 5_100,
  });

  assert.deepEqual((await store.load()).catchUp, {
    status: 'backlog',
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    candidateCountAtLeast: 121,
    reason: 'PAGE_BOUND',
    detectedAt: 5_100,
  });
});
