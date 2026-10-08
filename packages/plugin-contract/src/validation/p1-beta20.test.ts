import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';
import {
  isMediaSourceReadInput,
  isMediaSourceReadResult,
  isMediaSourceSettleInput,
} from './media-source.js';
import {
  validateMessagingRowInput,
  validateMessagingRowResult,
} from './messaging-wire.js';

const draft = (elements: readonly unknown[]) => ({
  address: { kind: 'thread_handle', handle: 'thread-1' },
  idempotencyKey: 'p1-beta20',
  payload: {
    provenance: { epistemicStatus: 'observation' },
    elements,
  },
});

test('Gate P freezes media_ref, rich_block, unavailable and warning payloads', () => {
  const elements = [
    {
      elementId: 'media-1',
      kind: 'media_ref',
      payload: {
        type: 'video',
        reference: 'pmr_provider-message-1',
        sourceId: 'media-source-1',
        fileName: 'clip.mp4',
        duration: 12,
      },
    },
    {
      elementId: 'rich-1',
      kind: 'rich_block',
      payload: { id: 'card-1', kind: 'card', v: 1, title: 'Status' },
    },
    {
      elementId: 'unavailable-1',
      kind: 'media_unavailable',
      payload: { type: 'video', fileName: 'lost.mp4', reason: 'timeout' },
    },
    {
      elementId: 'warning-1',
      kind: 'media_warning',
      payload: {
        mediaElementId: 'media-1',
        stage: 'preview',
        reason: 'processing_failed',
      },
    },
  ];
  const publicPmrDraft = { ...draft(elements), sourceEventId: 'provider-message-1' };
  assert.equal(validateMessagingRowInput('messaging.send', publicPmrDraft).valid, true);

  const missingSource = structuredClone(elements);
  delete (missingSource[0] as { payload: { sourceId?: string } }).payload.sourceId;
  assert.equal(validateMessagingRowInput('messaging.send', {
    ...draft(missingSource), sourceEventId: 'provider-message-1',
  }).valid, false);

  const hostRefWithSource = structuredClone(elements);
  Object.assign((hostRefWithSource[0] as { payload: Record<string, unknown> }).payload, {
    reference: 'hmr_opaque',
    sourceId: 'must-not-be-here',
  });
  assert.equal(validateMessagingRowInput('messaging.send', {
    ...draft(hostRefWithSource), sourceEventId: 'provider-message-1',
  }).valid, false);

  const danglingWarning = structuredClone(elements);
  (danglingWarning[3] as { payload: { mediaElementId: string } }).payload.mediaElementId = 'missing';
  assert.equal(validateMessagingRowInput('messaging.send', {
    ...draft(danglingWarning), sourceEventId: 'provider-message-1',
  }).valid, false);
});

test('Gate P admits all six current connector media producers before pmr migration', () => {
  const producerPayloads = [
    ['dingtalk', { type: 'audio', reference: 'download-code', duration: 12 }],
    ['feishu', { type: 'file', reference: 'file-key', fileName: 'report.pdf' }],
    ['telegram', { type: 'video', reference: 'telegram-file-id', duration: 9 }],
    ['wecom-agent', { type: 'image', reference: 'media-id' }],
    ['wecom-bot', { type: 'audio', reference: 'https://provider.test/audio|aeskey=opaque' }],
    ['weixin', { type: 'image', reference: 'cdn-media-key' }],
  ] as const;
  for (const [producer, payload] of producerPayloads) {
    const candidate = {
      ...draft([{
        elementId: `media-${producer}`,
        kind: 'media_ref',
        payload,
      }]),
      sourceEventId: `${producer}-message-1`,
    };
    assert.equal(
      validateMessagingRowInput('messaging.send', candidate).valid,
      true,
      `${producer} current media_ref output must remain schema-valid`,
    );
  }
});

test('Gate M closes media.read and media-source contribution shapes', () => {
  const whisperPmr = draft([{
    elementId: 'media-1', kind: 'media_ref',
    payload: { type: 'image', reference: 'pmr_provider-1', sourceId: 'source-1' },
  }]) as ReturnType<typeof draft> & { draftAudience?: unknown };
  whisperPmr.draftAudience = { kind: 'whisper', targets: ['cat-1'] };
  Object.assign(whisperPmr, { sourceEventId: 'provider-message-1' });
  assert.equal(validateMessagingRowInput('messaging.send', whisperPmr).valid, false);

  const whisperHmr = structuredClone(whisperPmr);
  const whisperHmrElement = whisperHmr.payload.elements[0] as {
    payload: { reference: string; sourceId?: string };
  };
  whisperHmrElement.payload.reference = 'hmr_opaque';
  delete whisperHmrElement.payload.sourceId;
  assert.equal(validateMessagingRowInput('messaging.send', whisperHmr).valid, true);

  const publicPmr = draft([{
    elementId: 'media-public', kind: 'media_ref',
    payload: { type: 'image', reference: 'pmr_provider-2', sourceId: 'source-1' },
  }]);
  assert.equal(validateMessagingRowInput('messaging.send', publicPmr).valid, false);
  assert.equal(validateMessagingRowInput('messaging.send', {
    ...publicPmr, sourceEventId: 'provider-message-2',
  }).valid, true);
  assert.equal(validateMessagingRowInput('messaging.send', draft([{
    elementId: 'text-1', kind: 'text', payload: { text: 'no media' },
  }])).valid, true);

  const append = (reference: string, sourceId?: string) => ({
    handle: { kind: 'message', token: 'opaque-handle' },
    operationId: `append-${reference}`,
    elements: [{
      elementId: 'media-appended',
      kind: 'media_ref',
      payload: { type: 'image', reference, ...(sourceId === undefined ? {} : { sourceId }) },
    }],
  });
  assert.equal(validateMessagingRowInput(
    'messaging.appendElements', append('pmr_provider-3', 'source-1'),
  ).valid, false);
  assert.equal(validateMessagingRowInput(
    'messaging.appendElements', append('hmr_opaque'),
  ).valid, true);

  assert.equal(validateMessagingRowInput('media.read', {
    reference: 'hmr_opaque',
    offset: 0,
    limit: 524_288,
  }).valid, true);
  assert.equal(validateMessagingRowResult('media.read', {
    offset: 0,
    dataBase64: 'AQID',
    nextOffset: 3,
    done: false,
  }).valid, true);
  assert.equal(validateMessagingRowResult('media.read', {
    offset: 0,
    dataBase64: '',
    nextOffset: 1,
    done: false,
  }).valid, false);
  assert.equal(validateMessagingRowInput('media.read', {
    reference: 'hmr_opaque',
    offset: 0,
    limit: 524_289,
  }).valid, false);

  assert.equal(isMediaSourceReadInput({
    requestId: 'request-1', reference: 'pmr_provider-1', offset: 0, limit: 524_288,
  }), true);
  assert.equal(isMediaSourceReadResult({
    kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: 'AQID', nextOffset: 3, done: false,
  }), true);
  assert.equal(isMediaSourceReadResult({
    kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: 'AQID', done: false,
  }), false);
  assert.equal(isMediaSourceReadResult({
    kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: '', nextOffset: 1, done: false,
  }), false);
  assert.equal(isMediaSourceReadResult({
    kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: '', nextOffset: 1, done: true,
  }), false);
  assert.equal(isMediaSourceReadResult({
    kind: 'rejected', requestId: 'request-1', code: 'MEDIA_SOURCE_UNAVAILABLE',
  }), true);
  assert.equal(isMediaSourceReadResult({
    kind: 'rejected', requestId: 'request-1', code: 'NOT_FOUND',
  }), false);
  assert.equal(isMediaSourceSettleInput({
    requestId: 'request-1', reference: 'pmr_provider-1', outcome: 'unavailable',
  }), true);

  const manifest = {
    pluginId: 'dev.clowder.media-source',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.21',
    name: 'Media source',
    features: [{
      id: 'media',
      name: 'Media',
      resources: [],
      capabilities: ['plugin.state.get', 'plugin.state.set'],
      contributions: [{ type: 'identity', id: 'connector' }, { type: 'media-source', id: 'provider' }],
    }],
    contributions: [{
      type: 'identity', id: 'connector', displayName: 'Connector', icon: 'icon.svg',
    }, {
      type: 'media-source',
      id: 'provider',
      binding: 'connector',
      readAction: { method: 'media.read-source' },
      settleAction: { method: 'media.settle-source' },
    }],
    runtime: { transport: 'stdio', entrypoint: 'dist/index.js' },
  };
  assert.equal(validateManifest(manifest).valid, true);

  const missingState = structuredClone(manifest);
  missingState.features[0]!.capabilities = ['plugin.state.get'];
  assert.equal(validateManifest(missingState).valid, false);

  const wrongBinding = structuredClone(manifest);
  wrongBinding.contributions[1]!.binding = 'other-identity';
  assert.equal(validateManifest(wrongBinding).valid, false);
});

test('Gate L closes presentation, lifecycle and pending publication receipts', () => {
  const presentation = {
    actor: { displayName: 'Opus', emoji: '🐱' },
    thread: { shortId: 't-1', title: 'Thread', featId: 'F202' },
    deepLinkUrl: 'https://cafe.example/thread/1',
  };
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    lifecycleId: 'life-1',
    deliveryId: 'delivery-1',
    threadId: 'thread-1',
    state: 'started',
    presentation,
  }).valid, true);
  assert.equal(validateMessagingRowResult('host.messaging.lifecycle', {
    deliveryId: 'delivery-1',
  }).valid, true);
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    lifecycleId: 'life-1',
    state: 'catching_up',
  }).valid, false);

  const forbidden = structuredClone(presentation);
  forbidden.deepLinkUrl = 'https://cafe.example/thread/1?ToKeN=secret';
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'started', presentation: forbidden,
  }).valid, false);

  const lifecycleEvents = [
    { lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'started', presentation },
    { lifecycleId: 'life-1', deliveryId: 'delivery-4', threadId: 'thread-1', state: 'catching_up' },
    { lifecycleId: 'life-1', deliveryId: 'delivery-5', threadId: 'thread-1', state: 'blocked', reason: 'waiting_for_input' },
    { lifecycleId: 'life-1', deliveryId: 'delivery-6', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed' },
  ] as const;
  for (const event of lifecycleEvents) {
    assert.equal(validateMessagingRowInput('host.messaging.lifecycle', event).valid, true);
    const { threadId: _threadId, ...withoutThreadId } = event;
    assert.equal(validateMessagingRowInput('host.messaging.lifecycle', withoutThreadId).valid, false);
  }

  assert.equal(validateMessagingRowResult('messaging.send', {
    messageId: 'reserved-1',
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: 'opaque-handle' },
    pendingPublication: true,
  }).valid, true);
  assert.equal(validateMessagingRowResult('messaging.send', {
    messageId: 'reserved-1',
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: 'opaque-handle' },
    publishSequence: 1,
    pendingPublication: true,
  }).valid, false);

  const lifecycleManifest = {
    pluginId: 'dev.clowder.lifecycle',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.21',
    name: 'Lifecycle',
    features: [{
      id: 'messages', name: 'Messages', resources: [], capabilities: [],
      contributions: [{ type: 'message-subscription', id: 'outbound' }],
    }],
    contributions: [{
      type: 'message-subscription', id: 'outbound', binding: 'messages',
      action: { method: 'messages.deliver' }, lifecycleAction: { method: 'messages.lifecycle' },
    }],
    runtime: { transport: 'stdio', entrypoint: 'dist/index.js' },
  };
  assert.equal(validateManifest(lifecycleManifest).valid, false);
  Object.assign(lifecycleManifest.contributions[0]!, { presentation: 'v1' });
  assert.equal(validateManifest(lifecycleManifest).valid, true);
});
