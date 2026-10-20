import assert from 'node:assert/strict';
import test from 'node:test';
import {isDeliveryPresentationContext,isMediaUnavailableMessageElement,isMediaWarningMessageElement} from './p1-runtime.js';
import {defineDeliveryAction} from './delivery.js';

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


test('delivery guard preserves execution feedback and rejects a mismatched receipt',async()=>{
 const action=defineDeliveryAction(input=>({deliveryId:input.deliveryId}));
 const status={kind:'execution_status',executionId:'e1',deliveryId:'d1',threadId:'t1',state:'settled',chainDone:true,outcome:'completed'};
 assert.deepEqual(await action(status),{deliveryId:'d1'});
 await assert.rejects(action({...status,threadId:undefined}),/invalid plugin delivery/);
 await assert.rejects(defineDeliveryAction(()=>({deliveryId:'other'}))(status),/invalid delivery receipt/);
});
