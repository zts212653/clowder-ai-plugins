import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LifecycleActionInputError,
  createMediaReader,
  decideLifecycleTransition,
  lifecycleRejectReason,
  defineMediaSourceReadAction,
  defineMediaSourceSettleAction,
  defineLifecycleAction,
  isDeliveryPresentationContext,
  isMediaUnavailableMessageElement,
  isMediaWarningMessageElement,
} from './p1-runtime.js';

test('Gate M: media reader exposes bounded chunks as AsyncIterable without readAll', async () => {
  const calls: unknown[] = [];
  const reader = createMediaReader(async (input) => {
    calls.push(input);
    return input.offset === 0
      ? { offset: 0, dataBase64: Buffer.from('abc').toString('base64'), nextOffset: 3, done: false }
      : { offset: 3, dataBase64: Buffer.from('de').toString('base64'), done: true };
  });

  const stream = reader.read('hmr_1');
  assert.equal('readAll' in stream, false);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks.map(chunk => Buffer.from(chunk).toString()), ['abc', 'de']);
  assert.deepEqual(calls, [
    { reference: 'hmr_1', offset: 0, limit: 512 * 1024 },
    { reference: 'hmr_1', offset: 3, limit: 512 * 1024 },
  ]);

  const discontinuous = createMediaReader(async () => ({
    offset: 0,
    dataBase64: Buffer.from('abc').toString('base64'),
    nextOffset: 4,
    done: false,
  }));
  await assert.rejects(async () => {
    for await (const _chunk of discontinuous.read('hmr_1')) {
      // Drain the stream to execute the protocol guard.
    }
  }, /discontinuous media cursor/);

  const stalled = createMediaReader(async () => ({
    offset: 0,
    dataBase64: '',
    nextOffset: 1,
    done: false,
  }));
  await assert.rejects(async () => {
    for await (const _chunk of stalled.read('hmr_1')) {
      // Drain the stream to execute the contract guard.
    }
  }, /invalid media\.read result/);
});

test('Gate M: media-source actions expose typed chunk, rejection, and settlement boundaries', async () => {
  const read = defineMediaSourceReadAction(async input => input.offset === 0
    ? {
        kind: 'chunk', requestId: input.requestId, offset: 0,
        dataBase64: Buffer.from('abc').toString('base64'), nextOffset: 3, done: false,
      }
    : { kind: 'rejected', requestId: input.requestId, code: 'MEDIA_SOURCE_UNAVAILABLE' });
  assert.deepEqual(await read({
    requestId: 'request-1', reference: 'pmr_provider-1', offset: 0, limit: 524_288,
  }), {
    kind: 'chunk', requestId: 'request-1', offset: 0,
    dataBase64: 'YWJj', nextOffset: 3, done: false,
  });
  assert.deepEqual(await read({
    requestId: 'request-2', reference: 'pmr_provider-1', offset: 3, limit: 524_288,
  }), { kind: 'rejected', requestId: 'request-2', code: 'MEDIA_SOURCE_UNAVAILABLE' });
  await assert.rejects(read({
    requestId: 'request-3', reference: 'hmr_not-provider', offset: 0, limit: 1,
  }));

  const settled: unknown[] = [];
  const settle = defineMediaSourceSettleAction(async input => { settled.push(input); });
  await settle({ requestId: 'request-1', reference: 'pmr_provider-1', outcome: 'imported' });
  assert.deepEqual(settled, [{ requestId: 'request-1', reference: 'pmr_provider-1', outcome: 'imported' }]);
  await assert.rejects(settle({ requestId: 'request-1', reference: 'pmr_provider-1', outcome: 'lost' }));
});

test('Gate L: lifecycle action guard preserves the discriminated union', async () => {
  const observedThreadIds: string[] = [];
  const action = defineLifecycleAction(async (input) => {
    observedThreadIds.push(input.threadId);
    return { deliveryId: input.deliveryId };
  });
  assert.deepEqual(await action({
    lifecycleId: 'lifecycle-1',
    deliveryId: 'delivery-1',
    threadId: 'thread-1',
    state: 'settled',
    chainDone: true,
    outcome: 'completed',
  }), { deliveryId: 'delivery-1' });
  assert.deepEqual(observedThreadIds, ['thread-1']);
  await assert.rejects(
    action({ lifecycleId: 'lifecycle-1', deliveryId: 'delivery-2', state: 'settled' }),
    LifecycleActionInputError,
  );
});

test('Gates P/L: presentation and typed media element guards fail closed', () => {
  assert.equal(isDeliveryPresentationContext({
    actor: { displayName: 'Opus', emoji: '🐱' },
    thread: { shortId: 'abc123', title: 'Thread' },
    deepLinkUrl: 'https://example.test/thread/1',
  }), true);
  assert.equal(isDeliveryPresentationContext({
    actor: { displayName: 'Opus', emoji: '🐱' },
    thread: { shortId: 'abc123' },
    deepLinkUrl: '/thread/1',
  }), false);
  assert.equal(isDeliveryPresentationContext({
    actor: { displayName: 'Opus', emoji: '🐱' },
    thread: { shortId: 'abc123' },
    deepLinkUrl: 'https://user@example.test/thread/1',
  }), false);
  assert.equal(isDeliveryPresentationContext({
    actor: { displayName: 'Opus', emoji: '🐱' },
    thread: { shortId: 'abc123' },
    deepLinkUrl: 'https://example.test/thread/1?ToKeN=secret',
  }), false);
  assert.equal(isMediaUnavailableMessageElement({
    elementId: 'media-1-unavailable',
    kind: 'media_unavailable',
    payload: { type: 'video', reason: 'timeout' },
  }), true);
  assert.equal(isMediaUnavailableMessageElement({
    elementId: 'media-1-unavailable',
    kind: 'media_unavailable',
    payload: { type: 'video', fileName: '', reason: 'timeout' },
  }), false);
  assert.equal(isMediaUnavailableMessageElement({
    elementId: 'text-1', kind: 'text', payload: { text: 'hello' },
  }), false);
  assert.equal(isMediaUnavailableMessageElement({
    elementId: 'media-1', kind: 'media_ref', payload: { type: 'file', reference: 'hmr_1' },
  }), false);
  assert.equal(isMediaUnavailableMessageElement({
    elementId: 'media-1-warning', kind: 'media_warning',
    payload: { mediaElementId: 'media-1', stage: 'transcription', reason: 'processing_failed' },
  }), false);
  assert.equal(isMediaWarningMessageElement({
    elementId: 'media-1-warning',
    kind: 'media_warning',
    payload: { mediaElementId: 'media-1', stage: 'transcription', reason: 'processing_failed' },
  }), true);
  assert.equal(isMediaWarningMessageElement({
    elementId: 'media-1-warning',
    kind: 'media_warning',
    payload: {
      mediaElementId: 'media-1',
      stage: 'transcription',
      reason: 'processing_failed',
      locator: 'must-not-pass',
    },
  }), false);
  assert.equal(isMediaWarningMessageElement({ kind: 'media_warning', payload: {} }), false);
});

test('Gate L: lifecycle transition helper accepts, replays and rejects the frozen sequence', () => {
  const started = {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: 'Opus', emoji: '🐱' }, thread: { shortId: 'abc123' } },
  } as const;
  const catchingUp1 = { lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'catching_up' } as const;
  const catchingUp2 = { lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'catching_up' } as const;
  const blocked = {
    lifecycleId: 'life-1', deliveryId: 'delivery-4', threadId: 'thread-1', state: 'blocked',
    reason: 'waiting_for_input', recoveryUrl: 'https://example.test/recover',
  } as const;
  const settled = {
    lifecycleId: 'life-1', deliveryId: 'delivery-5', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed',
  } as const;

  assert.deepEqual(decideLifecycleTransition([], started), { kind: 'accept' });
  assert.deepEqual(decideLifecycleTransition([started], started), { kind: 'replay' });
  assert.deepEqual(decideLifecycleTransition([started], {
    ...started,
    presentation: { ...started.presentation, actor: { displayName: 'Other', emoji: '🐱' } },
  }), {
    kind: 'reject', reason: 'DELIVERY_CONFLICT',
  });
  assert.deepEqual(decideLifecycleTransition([started], catchingUp1), { kind: 'accept' });
  assert.deepEqual(decideLifecycleTransition([started, catchingUp1], catchingUp2), { kind: 'accept' });
  assert.deepEqual(decideLifecycleTransition([started, catchingUp1, catchingUp2], blocked), { kind: 'accept' });
  assert.deepEqual(decideLifecycleTransition([started, blocked], settled), { kind: 'accept' });
  assert.deepEqual(decideLifecycleTransition([started, blocked], catchingUp1), { kind: 'reject', reason: 'OUT_OF_ORDER' });
  assert.deepEqual(decideLifecycleTransition([started, settled], blocked), { kind: 'reject', reason: 'OUT_OF_ORDER' });
  assert.deepEqual(decideLifecycleTransition([started, started], settled), { kind: 'reject', reason: 'INVALID_HISTORY' });

  assert.equal(lifecycleRejectReason({ kind: 'reject', reason: 'OUT_OF_ORDER' }), 'LIFECYCLE_OUT_OF_ORDER');
  assert.equal(lifecycleRejectReason({ kind: 'reject', reason: 'DELIVERY_CONFLICT' }), 'LIFECYCLE_DELIVERY_CONFLICT');
  assert.equal(lifecycleRejectReason({ kind: 'reject', reason: 'INVALID_HISTORY' }), 'PLUGIN_INTERNAL');
});
