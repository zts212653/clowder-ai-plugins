import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FeishuCatchUpRequiredError,
  createFeishuMeetingCatchUpService,
  createFileMeetingIntakeStateStore,
  type FeishuCatchUpDetector,
  type FeishuCatchUpScanner,
  type FeishuGeneratedArtifact,
} from './index.js';

const SIGNAL = new AbortController().signal;
const ARTIFACT: FeishuGeneratedArtifact = {
  artifactId: 'minute_recovery_1',
  kind: 'minute',
  revision: '1',
  generatedAt: '2026-08-23T08:00:00Z',
  title: 'Recovered meeting',
};

async function fixture(scan: FeishuCatchUpScanner['scanGeneratedArtifacts']) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-catch-up-'));
  const store = createFileMeetingIntakeStateStore(join(directory, 'state.json'));
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  const scanner: FeishuCatchUpScanner = { scanGeneratedArtifacts: scan };
  const detector: FeishuCatchUpDetector = { detectCatchUpRequirement: async () => undefined };
  return {
    store,
    service: createFeishuMeetingCatchUpService({ detector, scanner, store, now: () => 5_200 }),
  };
}

test('detect persists an old polling cursor as an owner decision before activation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-catch-up-detect-'));
  const store = createFileMeetingIntakeStateStore(join(directory, 'state.json'));
  await store.commitPage(null, 'poll-v1:1000', [], 1_000);
  const detector: FeishuCatchUpDetector = {
    async detectCatchUpRequirement(request) {
      assert.equal(request.cursor, 'poll-v1:1000');
      assert.equal(request.lastSuccessfulObservationAt, 1_000);
      throw new FeishuCatchUpRequiredError({
        fromCursor: request.cursor,
        throughCursor: 'poll-v1:5000',
        reason: 'CURSOR_GAP',
      });
    },
  };
  const scanner: FeishuCatchUpScanner = {
    scanGeneratedArtifacts: async request => ({ artifacts: [], nextCursor: request.throughCursor }),
  };
  const service = createFeishuMeetingCatchUpService({ detector, scanner, store, now: () => 5_200 });

  const result = await service.detect(SIGNAL);

  assert.equal(result.status, 'needs-owner');
  assert.deepEqual((await store.load()).catchUp, {
    status: 'needs-owner',
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    detectedAt: 5_200,
  });
});

test('detect leaves current cursors idle and does not scan or enqueue candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-catch-up-current-'));
  const store = createFileMeetingIntakeStateStore(join(directory, 'state.json'));
  let scans = 0;
  const detector: FeishuCatchUpDetector = { detectCatchUpRequirement: async () => undefined };
  const scanner: FeishuCatchUpScanner = {
    scanGeneratedArtifacts: async request => {
      scans += 1;
      return { artifacts: [], nextCursor: request.throughCursor };
    },
  };
  const service = createFeishuMeetingCatchUpService({ detector, scanner, store, now: () => 5_200 });

  const result = await service.detect(SIGNAL);

  assert.equal(result.status, 'idle');
  assert.equal(scans, 0);
  assert.deepEqual((await store.load()).pending, []);
});

test('preview reads the frozen window but does not enqueue or advance it', async () => {
  const { service, store } = await fixture(async request => {
    assert.equal(request.fromCursor, 'poll-v1:1000');
    assert.equal(request.throughCursor, 'poll-v1:5000');
    return { artifacts: [ARTIFACT], nextCursor: request.throughCursor };
  });

  const preview = await service.preview(SIGNAL);

  assert.equal(preview.candidateCount, 1);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  const state = await store.load();
  assert.equal(state.cursor, null);
  assert.deepEqual(state.pending, []);
  assert.equal(state.catchUp.status, 'previewed');
});

test('replay re-reads the frozen window and refuses changed preview truth', async () => {
  let artifacts: readonly FeishuGeneratedArtifact[] = [ARTIFACT];
  const { service, store } = await fixture(async request => ({
    artifacts,
    nextCursor: request.throughCursor,
  }));
  const preview = await service.preview(SIGNAL);
  artifacts = [{ ...ARTIFACT, revision: '2' }];

  await assert.rejects(service.replay(preview.fingerprint, SIGNAL), /preview changed/);
  assert.equal((await store.load()).catchUp.status, 'previewed');
  assert.deepEqual((await store.load()).pending, []);
});

test('matching replay commits the canonical events and cursor atomically', async () => {
  const { service, store } = await fixture(async request => ({
    artifacts: [ARTIFACT],
    nextCursor: request.throughCursor,
  }));
  const preview = await service.preview(SIGNAL);

  const resolved = await service.replay(preview.fingerprint, SIGNAL);

  assert.deepEqual(resolved, { action: 'replay', candidateCount: 1 });
  const state = await store.load();
  assert.equal(state.cursor, 'poll-v1:5000');
  assert.equal(state.pending.length, 1);
  assert.equal(state.catchUp.status, 'idle');
});

test('bounded scanner failures persist explicit backlog instead of generic unavailable', async () => {
  const { service, store } = await fixture(async request => {
    throw new FeishuCatchUpRequiredError({
      fromCursor: request.fromCursor,
      throughCursor: request.throughCursor,
      reason: 'PAGE_BOUND',
      candidateCountAtLeast: 121,
    });
  });

  await assert.rejects(service.preview(SIGNAL), FeishuCatchUpRequiredError);
  assert.deepEqual((await store.load()).catchUp, {
    status: 'backlog',
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    candidateCountAtLeast: 121,
    reason: 'PAGE_BOUND',
    detectedAt: 5_200,
  });
});
