import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EventsPublishInput, EventsPublishResult } from '@clowder-ai/plugin-contract';

import {
  FeishuCatchUpRequiredError,
  FeishuGatewayError,
  createFeishuMeetingIntakeRuntime,
  createFileMeetingIntakeStateStore,
  normalizeGeneratedArtifact,
  type FeishuPollingGateway,
  type FeishuGeneratedArtifact,
  type MeetingIntakeStateStore,
} from './index.js';

const ARTIFACT: FeishuGeneratedArtifact = {
  artifactId: 'om_abc123',
  kind: 'minute',
  revision: '7',
  generatedAt: '2026-08-09T04:12:31Z',
  title: 'F292 design review',
};
const SIGNAL = new AbortController().signal;

function gateway(overrides: Partial<FeishuPollingGateway> = {}): FeishuPollingGateway {
  return {
    listGeneratedArtifacts: async () => ({
      artifacts: [ARTIFACT],
      nextCursor: 'cursor-2',
    }),
    inspectArtifact: async () => ARTIFACT,
    ...overrides,
  };
}

class RecordingPublisher {
  readonly calls: EventsPublishInput[] = [];
  fail = false;
  disposition: EventsPublishResult['disposition'] = 'accepted';

  async publish(input: unknown): Promise<EventsPublishResult> {
    this.calls.push(structuredClone(input as EventsPublishInput));
    if (this.fail) throw new Error('Host unavailable');
    return { publicationId: 'publication-1', disposition: this.disposition };
  }
}

async function fileStore(): Promise<MeetingIntakeStateStore> {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-intake-'));
  return createFileMeetingIntakeStateStore(join(directory, 'state.json'));
}

test('commits the page to durable outbox before publishing and recovers after restart', async () => {
  const store = await fileStore();
  const firstPublisher = new RecordingPublisher();
  firstPublisher.fail = true;
  const first = createFeishuMeetingIntakeRuntime({
    gateway: gateway(),
    publisher: firstPublisher,
    store,
    now: () => 1_000,
  });

  await assert.rejects(first.pollOnce(SIGNAL), /Host unavailable/);
  assert.deepEqual(await store.load(), {
    v: 2,
    cursor: 'cursor-2',
    pending: [firstPublisher.calls[0]],
    health: {
      status: 'degraded',
      code: 'PUBLISH_FAILED',
      lastCycleAt: 1_000,
      lastSuccessfulObservationAt: 1_000,
      lastPublishedAt: null,
    },
    catchUp: { status: 'idle' },
  });

  const restartedPublisher = new RecordingPublisher();
  restartedPublisher.disposition = 'duplicate';
  const restarted = createFeishuMeetingIntakeRuntime({
    gateway: gateway({
      listGeneratedArtifacts: async ({ cursor }) => {
        assert.equal(cursor, 'cursor-2');
        return { artifacts: [], nextCursor: cursor };
      },
    }),
    publisher: restartedPublisher,
    store,
  });
  assert.deepEqual(await restarted.pollOnce(SIGNAL), { discovered: 0, published: 1 });
  assert.equal((await store.load()).pending.length, 0);
  assert.equal(restartedPublisher.calls.length, 1);
});

test('redelivers after a crash between Host acceptance and durable acknowledgement', async () => {
  const durableStore = await fileStore();
  let failAcknowledge = true;
  const crashStore: MeetingIntakeStateStore = {
    load: () => durableStore.load(),
    commitPage: (...args) => durableStore.commitPage(...args),
    enqueue: (events) => durableStore.enqueue(events),
    setHealth: (health) => durableStore.setHealth(health),
    requireCatchUp: (input) => durableStore.requireCatchUp(input),
    refreshEmptyCatchUpPreview: (input) => durableStore.refreshEmptyCatchUpPreview(input),
    recordCatchUpPreview: (input) => durableStore.recordCatchUpPreview(input),
    resolveCatchUpFutureOnly: (...args) => durableStore.resolveCatchUpFutureOnly(...args),
    resolveCatchUpReplay: (...args) => durableStore.resolveCatchUpReplay(...args),
    acknowledge: async (idempotencyKey, publishedAt) => {
      if (failAcknowledge) {
        failAcknowledge = false;
        throw new Error('simulated crash before outbox acknowledgement');
      }
      await durableStore.acknowledge(idempotencyKey, publishedAt);
    },
  };
  const firstPublisher = new RecordingPublisher();
  const first = createFeishuMeetingIntakeRuntime({
    gateway: gateway(),
    publisher: firstPublisher,
    store: crashStore,
  });

  await assert.rejects(first.pollOnce(SIGNAL), /simulated crash/);
  assert.equal(firstPublisher.calls.length, 1, 'Host accepted the first attempt');
  assert.equal((await durableStore.load()).pending.length, 1, 'outbox still owns recovery');

  const duplicatePublisher = new RecordingPublisher();
  duplicatePublisher.disposition = 'duplicate';
  const restarted = createFeishuMeetingIntakeRuntime({
    gateway: gateway({
      listGeneratedArtifacts: async ({ cursor }) => ({
        artifacts: [],
        nextCursor: cursor,
      }),
    }),
    publisher: duplicatePublisher,
    store: durableStore,
  });
  assert.deepEqual(await restarted.pollOnce(SIGNAL), { discovered: 0, published: 1 });
  assert.equal(duplicatePublisher.calls.length, 1);
  assert.equal((await durableStore.load()).pending.length, 0);
});

test('does not advance cursor when any page artifact is invalid', async () => {
  const store = await fileStore();
  const publisher = new RecordingPublisher();
  const runtime = createFeishuMeetingIntakeRuntime({
    gateway: gateway({
      listGeneratedArtifacts: async () => ({
        artifacts: [ARTIFACT, { ...ARTIFACT, transcript: 'leak' } as FeishuGeneratedArtifact],
        nextCursor: 'cursor-unsafe',
      }),
    }),
    publisher,
    store,
  });

  await assert.rejects(runtime.pollOnce(SIGNAL));
  assert.equal((await store.load()).cursor, null);
  assert.equal(publisher.calls.length, 0);
});

test('state store rejects direct transcript and forged-source bypasses', async () => {
  const store = await fileStore();
  const valid = normalizeGeneratedArtifact(ARTIFACT);
  for (const candidate of [
    { ...valid, payload: { transcript: 'private meeting' } },
    { ...valid, source: { handle: 'https://attacker.example/transcript' } },
    {
      ...valid,
      source: { handle: 'feishu://meeting-artifacts/minute/other?revision=7' },
    },
  ]) {
    await assert.rejects(
      store.enqueue([candidate as EventsPublishInput]),
      /invalid signal/,
    );
  }
  assert.equal((await store.load()).pending.length, 0);
});

test('manual import deduplicates with later page delivery by source artifact identity', async () => {
  const store = await fileStore();
  const publisher = new RecordingPublisher();
  publisher.fail = true;
  const runtime = createFeishuMeetingIntakeRuntime({ gateway: gateway(), publisher, store });

  await assert.rejects(
    runtime.importArtifact(
      { artifactId: 'om_abc123', kind: 'minute', revision: '7' },
      SIGNAL,
    ),
  );
  await assert.rejects(runtime.pollOnce(SIGNAL));
  assert.equal((await store.load()).pending.length, 1);
});

test('forwards Host-owned cancellation to polling and manual source access', async () => {
  const seen: AbortSignal[] = [];
  const source = gateway({
    listGeneratedArtifacts: async ({ signal }) => {
      seen.push(signal);
      return { artifacts: [], nextCursor: null };
    },
    inspectArtifact: async (_locator, signal) => {
      seen.push(signal);
      return ARTIFACT;
    },
  });
  const runtime = createFeishuMeetingIntakeRuntime({
    gateway: source,
    publisher: new RecordingPublisher(),
    store: await fileStore(),
  });

  await runtime.pollOnce(SIGNAL);
  await runtime.importArtifact(
    { artifactId: 'om_abc123', kind: 'minute', revision: '7' },
    SIGNAL,
  );
  assert.deepEqual(seen, [SIGNAL, SIGNAL]);
});

test('persists typed auth health and leaves pending work untouched', async () => {
  const store = await fileStore();
  const publisher = new RecordingPublisher();
  const runtime = createFeishuMeetingIntakeRuntime({
    gateway: gateway({
      listGeneratedArtifacts: async () => {
        throw new FeishuGatewayError('AUTH_EXPIRED', 'Feishu login expired');
      },
    }),
    publisher,
    store,
  });

  await assert.rejects(runtime.pollOnce(SIGNAL), FeishuGatewayError);
  assert.deepEqual((await store.load()).health, {
    status: 'auth-expired',
    code: 'AUTH_EXPIRED',
    lastCycleAt: null,
    lastSuccessfulObservationAt: null,
    lastPublishedAt: null,
  });
});

test('persists a typed offline gap and blocks without terminating the runtime', async () => {
  const store = await fileStore();
  const runtime = createFeishuMeetingIntakeRuntime({
    gateway: gateway({
      listGeneratedArtifacts: async () => {
        throw new FeishuCatchUpRequiredError({
          fromCursor: 'poll-v1:1000',
          throughCursor: 'poll-v1:5000',
          reason: 'CURSOR_GAP',
        });
      },
    }),
    publisher: new RecordingPublisher(),
    store,
    now: () => 5_100,
  });

  assert.deepEqual(await runtime.pollOnce(SIGNAL), {
    discovered: 0,
    published: 0,
    blocked: 'catch-up',
  });
  assert.equal((await store.load()).health.code, 'CATCH_UP_REQUIRED');
  assert.deepEqual(await runtime.pollOnce(SIGNAL), {
    discovered: 0,
    published: 0,
    blocked: 'catch-up',
  });
});
