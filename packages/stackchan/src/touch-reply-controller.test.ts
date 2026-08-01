import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PhysicalLimbObservation,
  PhysicalLimbTouchObservation,
} from '@clowder-ai/plugin-contract';

import {
  createStackChanTouchReplyController,
  parseStackChanTouchEvent,
  type StackChanGatewayClient,
} from './touch-reply-controller.js';

const RAW_STROKE_EVENT = {
  event_type: 'touch',
  subtype: 'stroke',
  duration_ms: 840,
  action: 'head_stroke',
  ts: 12_340,
  ts_unix: 1_785_576_000.25,
  session_id: 'device-session-1',
};

function createIdFactory(): () => string {
  let next = 0;
  return () => `generated-${++next}`;
}

test('projects a validated gateway stroke into one typed touch observation', () => {
  const observation = parseStackChanTouchEvent(RAW_STROKE_EVENT, {
    nodeId: 'stackchan-desk-1',
    observationId: 'touch-1',
  });

  assert.deepEqual(observation, {
    v: 1,
    observationId: 'touch-1',
    nodeId: 'stackchan-desk-1',
    occurredAt: '2026-08-01T09:20:00.250Z',
    sessionId: 'device-session-1',
    kind: 'touch',
    payload: {
      gesture: 'stroke',
      durationMs: 840,
      confidence: 1,
    },
  } satisfies PhysicalLimbTouchObservation);
});

test('rejects malformed and over-bound gateway events instead of leaking raw fields', () => {
  const invalidEvents = [
    { ...RAW_STROKE_EVENT, event_type: 'camera' },
    { ...RAW_STROKE_EVENT, subtype: 'swipe' },
    { ...RAW_STROKE_EVENT, duration_ms: 10_001 },
    { ...RAW_STROKE_EVENT, ts_unix: Number.NaN },
    { ...RAW_STROKE_EVENT, session_id: '' },
    { ...RAW_STROKE_EVENT, raw_touch_samples: [1, 2, 3] },
  ];

  for (const event of invalidEvents) {
    assert.equal(
      parseStackChanTouchEvent(event, {
        nodeId: 'stackchan-desk-1',
        observationId: 'touch-invalid',
      }),
      null,
    );
  }
});

test('starts the local look-up listen reflex before emitting touch and transcript observations', async () => {
  const order: string[] = [];
  const observations: PhysicalLimbObservation[] = [];
  let finishListen: ((value: {
    text: string;
    language: string;
    durationMs: number;
  }) => void) | undefined;

  const gateway: StackChanGatewayClient = {
    listen(request) {
      order.push('listen');
      assert.deepEqual(request, {
        durationMs: 5_000,
        engine: 'faster-whisper',
        language: 'zh',
        motion: 'look-up',
        lookUpPitch: 50,
      });
      return new Promise((resolve) => {
        finishListen = resolve;
      });
    },
  };

  const controller = createStackChanTouchReplyController({
    nodeId: 'stackchan-desk-1',
    gateway,
    emitObservation(observation) {
      order.push(`emit:${observation.kind}`);
      observations.push(observation);
    },
    createId: createIdFactory(),
  });

  const run = controller.handleGatewayEvent(RAW_STROKE_EVENT);
  await Promise.resolve();

  assert.deepEqual(order, ['listen', 'emit:touch']);
  assert.ok(finishListen);
  finishListen({
    text: '砚砚你在吗',
    language: 'zh',
    durationMs: 4_920,
  });

  assert.deepEqual(await run, {
    status: 'completed',
    interactionId: 'generated-2',
    transcriptObservationId: 'generated-3',
  });
  assert.deepEqual(order, ['listen', 'emit:touch', 'emit:transcript']);
  assert.deepEqual(observations[1], {
    v: 1,
    observationId: 'generated-3',
    nodeId: 'stackchan-desk-1',
    occurredAt: '2026-08-01T09:20:05.170Z',
    sessionId: 'device-session-1',
    kind: 'transcript',
    payload: {
      interactionId: 'generated-2',
      text: '砚砚你在吗',
      language: 'zh',
      captureDurationMs: 4_920,
    },
  });
});

test('debounces duplicate or concurrent touches and never opens two microphone windows', async () => {
  let listenCalls = 0;
  let finishListen: ((value: {
    text: string;
    language: string;
    durationMs: number;
  }) => void) | undefined;

  const controller = createStackChanTouchReplyController({
    nodeId: 'stackchan-desk-1',
    gateway: {
      listen() {
        listenCalls += 1;
        return new Promise((resolve) => {
          finishListen = resolve;
        });
      },
    },
    emitObservation() {},
    createId: createIdFactory(),
  });

  const first = controller.handleGatewayEvent(RAW_STROKE_EVENT);
  await Promise.resolve();
  assert.deepEqual(
    await controller.handleGatewayEvent({
      ...RAW_STROKE_EVENT,
      ts: 12_341,
      ts_unix: RAW_STROKE_EVENT.ts_unix + 0.2,
    }),
    { status: 'ignored', reason: 'capture_active' },
  );
  assert.equal(listenCalls, 1);

  assert.ok(finishListen);
  finishListen({ text: '', language: 'zh', durationMs: 5_000 });
  assert.deepEqual(await first, { status: 'completed', interactionId: 'generated-2' });

  assert.deepEqual(await controller.handleGatewayEvent(RAW_STROKE_EVENT), {
    status: 'ignored',
    reason: 'duplicate',
  });
  assert.equal(listenCalls, 1);
});

test('fails closed when local listen fails and emits no transcript observation', async () => {
  const observations: PhysicalLimbObservation[] = [];
  const controller = createStackChanTouchReplyController({
    nodeId: 'stackchan-desk-1',
    gateway: {
      async listen() {
        throw new Error('speech dependency missing');
      },
    },
    emitObservation(observation) {
      observations.push(observation);
    },
    createId: createIdFactory(),
  });

  assert.deepEqual(await controller.handleGatewayEvent(RAW_STROKE_EVENT), {
    status: 'failed',
    reason: 'speech dependency missing',
  });
  assert.deepEqual(observations.map(({ kind }) => kind), ['touch']);
});
