import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentBubble } from '../src/recent-bubble.mjs';
import { VisibleTextPresentation } from '../src/visible-text-receipt.mjs';

const CALL_A = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const frames = [];
  const reports = [];
  const window = {
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle(value) { return value.style; },
  };
  const document = {
    visibilityState: 'visible',
    defaultView: window,
    documentElement: { clientWidth: 320, clientHeight: 240 },
    addEventListener() {},
    removeEventListener() {},
  };
  async function frame() {
    const callback = frames.shift();
    assert(callback, 'the presentation should defer observation to a frame');
    callback();
    await Promise.resolve();
    await Promise.resolve();
  }
  return { document, frames, reports, frame };
}

function node() {
  const panel = {
    hidden: false,
    parentElement: null,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getAttribute() { return null; },
  };
  return {
    hidden: false,
    isConnected: true,
    parentElement: panel,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    dataset: {},
    getAttribute() { return null; },
    getClientRects() { return [{ left: 10, top: 10, right: 110, bottom: 40 }]; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 40 }; },
  };
}

test('a reused glance row resolves its current owner instead of reporting a stale message', async () => {
  const f = fixture();
  const bubble = new RecentBubble([node(), node()]);
  const callBubble = new RecentBubble([node(), node()]);
  const presentation = new VisibleTextPresentation({
    document: f.document,
    report: async observation => { f.reports.push(observation); return { kind: 'ok' }; },
    transcript: { append: () => undefined },
    callTranscript: {
      setCall() {},
      appendLive: () => undefined,
      load: () => true,
      rowForMessage: () => undefined,
    },
    bubble,
    callBubble,
  });
  presentation.setCall(CALL_A);
  presentation.loadTranscript(CALL_A, {
    kind: 'transcript', rows: [
      { messageId: 'm-a1', role: 'assistant', text: 'first answer', source: { kind: 'voice' } },
    ],
  }, '猫猫');
  presentation.loadTranscript(CALL_A, {
    kind: 'transcript', rows: [
      { messageId: 'm-a1', role: 'assistant', text: 'first answer', source: { kind: 'voice' } },
      { messageId: 'm-u1', role: 'user', text: 'follow up', source: { kind: 'voice' } },
      { messageId: 'm-a2', role: 'assistant', text: 'second answer', source: { kind: 'voice' } },
    ],
  }, '猫猫');

  await f.frame();

  assert.deepEqual(f.reports.map(value => value.reference), [
    { kind: 'message', messageId: 'm-a2' },
  ]);
});

test('empty assistant deltas never become a visible-text receipt', () => {
  const f = fixture();
  const visible = node();
  const view = { append: () => visible };
  const presentation = new VisibleTextPresentation({
    document: f.document,
    report: async observation => { f.reports.push(observation); return { kind: 'ok' }; },
    transcript: view,
    callTranscript: { setCall() {}, appendLive: () => visible },
    bubble: { append: () => visible, rowsForReference: () => [] },
    callBubble: { append: () => visible, rowsForReference: () => [] },
  });
  presentation.setCall(CALL_A);
  presentation.appendLive({
    type: 'transcript', callId: CALL_A, role: 'assistant', text: ' \n ', itemId: 'empty-item',
  }, '猫猫');
  assert.equal(f.frames.length, 0);
});

test('whitespace-only durable rows never become a visible-text receipt', () => {
  const f = fixture();
  const visible = node();
  const presentation = new VisibleTextPresentation({
    document: f.document,
    report: async observation => { f.reports.push(observation); return { kind: 'ok' }; },
    transcript: { append: () => undefined },
    callTranscript: {
      setCall() {},
      load: () => true,
      rowForMessage: () => visible,
    },
    bubble: { rowsForReference: () => [] },
    callBubble: { loadTranscript() {}, rowsForReference: () => [] },
  });
  presentation.setCall(CALL_A);
  presentation.loadTranscript(CALL_A, {
    kind: 'transcript', rows: [
      { messageId: 'blank', role: 'assistant', text: ' \n ', source: { kind: 'voice' } },
    ],
  }, '猫猫');
  assert.equal(f.frames.length, 0);
});

test('the ordinary live bubble resolves the latest reference after its fixed row is reused', async () => {
  const f = fixture();
  const bubble = new RecentBubble([node(), node()]);
  const callBubble = new RecentBubble([node({ hidden: true }), node({ hidden: true })]);
  const presentation = new VisibleTextPresentation({
    document: f.document,
    report: async observation => { f.reports.push(observation); return { kind: 'ok' }; },
    transcript: { append: () => undefined },
    callTranscript: { setCall() {}, appendLive: () => undefined },
    bubble,
    callBubble,
  });
  presentation.setCall(CALL_A);
  presentation.appendLive({
    type: 'transcript', callId: CALL_A, role: 'assistant', text: 'A1', itemId: 'live-a1',
  }, '猫猫');
  presentation.appendLive({
    type: 'transcript', callId: CALL_A, role: 'user', text: 'U1', itemId: 'live-u1',
  }, '语音');
  presentation.appendLive({
    type: 'transcript', callId: CALL_A, role: 'assistant', text: 'A2', itemId: 'live-a2',
  }, '猫猫');

  await f.frame();

  assert.deepEqual(f.reports.map(value => value.reference), [
    { kind: 'native-item', nativeItemId: 'live-a2' },
  ]);
});
