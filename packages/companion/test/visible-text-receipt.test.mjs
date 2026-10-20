import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FirstVisibleTextReceipt } from '../src/visible-text-receipt.mjs';

const CALL_A = '11111111-1111-4111-8111-111111111111';
const CALL_B = '22222222-2222-4222-8222-222222222222';

function fixture({ report, now = () => 1_791_804_000_123 } = {}) {
  const frames = [];
  const reports = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const window = {
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    removeEventListener(name) { windowListeners.delete(name); },
    getComputedStyle(node) { return node.style ?? { display: 'block', visibility: 'visible', opacity: '1' }; },
  };
  const document = {
    visibilityState: 'visible',
    defaultView: window,
    documentElement: { clientWidth: 320, clientHeight: 240 },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    removeEventListener(name) { documentListeners.delete(name); },
  };
  const receipt = new FirstVisibleTextReceipt({
    document,
    report: async observation => {
      reports.push(observation);
      return report ? report(observation) : { kind: 'ok' };
    },
    now,
  });
  async function frame() {
    const callback = frames.shift();
    assert(callback, 'an observation check should wait for an animation frame');
    callback();
    await Promise.resolve();
    await Promise.resolve();
  }
  return { document, receipt, reports, frames, documentListeners, windowListeners, frame };
}

function node({
  hidden = false,
  rect = { left: 10, top: 10, right: 110, bottom: 40 },
  style = { display: 'block', visibility: 'visible', opacity: '1' },
  panelRect,
  panelStyle = { display: 'block', visibility: 'visible', opacity: '1' },
} = {}) {
  const panel = {
    hidden,
    parentElement: null,
    style: panelStyle,
    getAttribute() { return null; },
    getBoundingClientRect() { return panelRect; },
  };
  return {
    isConnected: true,
    parentElement: panel,
    style,
    getAttribute() { return null; },
    getClientRects() { return this.isConnected && !panel.hidden ? [rect] : []; },
    getBoundingClientRect() { return rect; },
    setRect(value) { rect = value; },
    panel,
  };
}

test('hidden and offscreen text stays pending, then reports once after a visible frame', async () => {
  const f = fixture();
  const row = node({ hidden: true });
  f.receipt.setCall(CALL_A);

  assert.equal(f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'output-item-1' },
    nodes: [row],
  }), true);
  await f.frame();
  assert.deepEqual(f.reports, []);

  row.panel.hidden = false;
  row.setRect({ left: 400, top: 10, right: 500, bottom: 40 });
  f.receipt.retry();
  await f.frame();
  assert.deepEqual(f.reports, []);

  row.setRect({ left: 10, top: 10, right: 110, bottom: 40 });
  f.receipt.retry();
  await f.frame();
  assert.deepEqual(f.reports, [{
    event: 'first_text_visible', observedAt: 1_791_804_000_123, callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'output-item-1' },
  }]);

  f.receipt.retry();
  assert.equal(f.frames.length, 0, 'a settled call never emits a duplicate observation');
});

test('document visibility and later panel changes keep the observation path alive', async () => {
  const f = fixture();
  const row = node();
  f.document.visibilityState = 'hidden';
  f.receipt.setCall(CALL_A);
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'message', messageId: 'message-1' },
    nodes: [row],
  });
  await f.frame();
  assert.deepEqual(f.reports, []);

  f.document.visibilityState = 'visible';
  f.documentListeners.get('visibilitychange')();
  await f.frame();
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].reference, { kind: 'message', messageId: 'message-1' });
});

test('foreign, stale and duplicate candidates cannot cross the current-call fence', async () => {
  const f = fixture();
  const row = node();
  f.receipt.setCall(CALL_A);
  assert.equal(f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'foreign' },
    nodes: [row],
  }), false);
  assert.equal(f.frames.length, 0);

  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'stale' },
    nodes: [row],
  });
  f.receipt.setCall(CALL_B);
  await f.frame();
  assert.deepEqual(f.reports, [], 'a queued frame cannot report after the call changes');

  f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'current' },
    nodes: [row],
  });
  f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'current' },
    nodes: [row],
  });
  await f.frame();
  assert.equal(f.reports.length, 1);
});

test('an old in-flight receipt cannot clear or settle the next call attempt', async () => {
  let settleOld;
  const f = fixture({ report: () => new Promise(resolve => { settleOld ??= resolve; }) });
  const row = node();
  f.receipt.setCall(CALL_A);
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'old-current' },
    nodes: [row],
  });
  await f.frame();
  assert.equal(f.reports.length, 1);

  f.receipt.setCall(CALL_B);
  f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'new-current' },
    nodes: [row],
  });
  assert.equal(f.frames.length, 0, 'the new call waits behind the already submitted receipt');

  settleOld({ kind: 'ok' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.frames.length, 1, 'settling the stale receipt schedules the current call');
  await f.frame();
  assert.equal(f.reports.length, 2);
  assert.equal(f.reports[1].callId, CALL_B);
});

test('a permanently rejected candidate is discarded so the next visible reference can report', async () => {
  const attempted = [];
  const f = fixture({ report: async observation => {
    attempted.push(observation.reference);
    if (observation.reference.nativeItemId === 'unknown-item') {
      throw Object.assign(new Error('unknown item'), { code: 'invalid_request' });
    }
    return { kind: 'ok' };
  } });
  f.receipt.setCall(CALL_A);
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'unknown-item' },
    nodes: [node()],
  });
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'known-item' },
    nodes: [node()],
  });

  await f.frame();
  assert.equal(f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'unknown-item' },
    nodes: [node()],
  }), false, 'a permanently rejected reference stays rejected for the current call');
  assert.equal(f.frames.length, 1, 'discarding a permanent rejection schedules the next candidate');
  await f.frame();

  assert.deepEqual(attempted, [
    { kind: 'native-item', nativeItemId: 'unknown-item' },
    { kind: 'native-item', nativeItemId: 'known-item' },
  ]);

  f.receipt.setCall(CALL_B);
  assert.equal(f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'unknown-item' },
    nodes: [node()],
  }), true, 'a new call gets a fresh bounded rejection set');
  await f.frame();
  assert.equal(attempted.length, 3);
});

test('transient Host failures respect backoff and stop after a bounded attempt budget', async () => {
  let clock = 10_000;
  let attempts = 0;
  const f = fixture({
    now: () => clock,
    report: async observation => {
      attempts += 1;
      if (observation.callId === CALL_B) return { kind: 'ok' };
      throw Object.assign(new Error('busy'), { code: 'busy' });
    },
  });
  f.receipt.setCall(CALL_A);
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'temporarily-unavailable' },
    nodes: [node()],
  });

  await f.frame();
  f.receipt.retry();
  await f.frame();
  assert.equal(attempts, 1, 'an eager retry cannot bypass the first backoff');

  clock += 1_000;
  f.receipt.retry();
  await f.frame();
  assert.equal(attempts, 2);

  clock += 2_000;
  f.receipt.retry();
  await f.frame();
  assert.equal(attempts, 3);
  f.receipt.retry();
  assert.equal(f.frames.length, 0, 'exhaustion leaves the first-visible result unknown');
  assert.equal(f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'later-item' },
    nodes: [node()],
  }), false, 'later text cannot manufacture success after the first visible candidate exhausted');

  f.receipt.setCall(CALL_B);
  assert.equal(f.receipt.observe({
    callId: CALL_B,
    reference: { kind: 'native-item', nativeItemId: 'next-call-item' },
    nodes: [node()],
  }), true);
  await f.frame();
  assert.equal(attempts, 4, 'a new call resets the unknown terminal and gets its own receipt');
});

test('overflow clipping and CSS-hidden nodes do not win over visible text', async () => {
  const f = fixture();
  f.receipt.setCall(CALL_A);
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'clipped' },
    nodes: [node({
      rect: { left: 10, top: 80, right: 110, bottom: 110 },
      panelRect: { left: 0, top: 0, right: 160, bottom: 50 },
      panelStyle: { display: 'block', visibility: 'visible', opacity: '1', overflow: 'hidden' },
    })],
  });
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'transparent' },
    nodes: [node({ style: { display: 'block', visibility: 'visible', opacity: '0' } })],
  });
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'visibility-hidden' },
    nodes: [node({ style: { display: 'block', visibility: 'hidden', opacity: '1' } })],
  });
  f.receipt.observe({
    callId: CALL_A,
    reference: { kind: 'native-item', nativeItemId: 'visible' },
    nodes: [node()],
  });

  await f.frame();

  assert.deepEqual(f.reports[0].reference, { kind: 'native-item', nativeItemId: 'visible' });
});

test('the pending queue stays bounded and evicts its oldest unresolved candidate', async () => {
  const f = fixture();
  f.receipt.setCall(CALL_A);
  for (let index = 0; index < 65; index += 1) {
    f.receipt.observe({
      callId: CALL_A,
      reference: { kind: 'native-item', nativeItemId: `item-${index}` },
      nodes: [node()],
    });
  }

  await f.frame();

  assert.deepEqual(f.reports[0].reference, { kind: 'native-item', nativeItemId: 'item-1' });
});

test('a successful prior call does not suppress the next call receipt', async () => {
  const f = fixture();
  f.receipt.setCall(CALL_A);
  f.receipt.observe({ callId: CALL_A, reference: { kind: 'message', messageId: 'a' }, nodes: [node()] });
  await f.frame();
  f.receipt.setCall(CALL_B);
  f.receipt.observe({ callId: CALL_B, reference: { kind: 'message', messageId: 'b' }, nodes: [node()] });
  await f.frame();
  assert.deepEqual(f.reports.map(value => value.callId), [CALL_A, CALL_B]);
});
