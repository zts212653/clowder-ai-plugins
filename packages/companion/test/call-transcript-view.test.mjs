import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallTranscriptView } from '../src/call-transcript-view.mjs';

const CALL_A = '11111111-1111-4111-8111-111111111111';
const CALL_B = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const unread = [];
  const document = {
    createElement: () => ({
      dataset: {}, textContent: '', className: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      remove() { container.children = container.children.filter(row => row !== this); },
    }),
  };
  const container = {
    ownerDocument: document,
    children: [],
    dataset: {},
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    append(...rows) { this.children.push(...rows); },
    replaceChildren(...rows) { this.children = rows; },
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight }; },
  };
  return {
    container,
    unread,
    view: new CallTranscriptView(container, { onUnread: count => unread.push(count) }),
  };
}

const scope = callId => ({ callId, realtimeSessionId: `rtc-${callId}` });
const voice = (messageId, role, text, nativeItemId, nativeTurnId) => ({
  messageId,
  role,
  text,
  source: {
    kind: 'voice',
    nativeThreadId: 'thread-native',
    realtimeSessionId: `rtc-${CALL_A}`,
    nativeItemId,
    ...(nativeTurnId ? { nativeTurnId } : {}),
  },
});
const typed = (messageId, text, clientMessageId = `client-${messageId}`) => ({
  messageId,
  role: 'user',
  text,
  source: { kind: 'typed', clientMessageId, callId: CALL_A },
});

test('durable transcript keeps Host order and source identity without pairing rows', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [
    voice('m1', 'user', 'It is like an assistant.', 'input-1'),
    voice('m2', 'assistant', '它就像一个始终支持你的助手。', 'output-1'),
    typed('m3', '等下，他说的是哪个 API？'),
  ] });

  assert.deepEqual(container.children.map(row => row.textContent), [
    'It is like an assistant.',
    '它就像一个始终支持你的助手。',
    '等下，他说的是哪个 API？',
  ]);
  assert.deepEqual(container.children.map(row => row.dataset.source), ['voice', 'voice', 'typed']);
  assert.equal(container.children[0].className, 'call-transcript-row voice user');
  assert.equal(container.children[1].className, 'call-transcript-row voice assistant');
  assert.equal(container.children[2].className, 'call-transcript-row typed user');
  assert.equal(container.dataset.hasMore, 'false');
});

test('live captions reconcile by native item id while repeated text remains distinct', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'user', text: 'same', itemId: 'input-1', turnId: 'turn-1' });
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'user', text: 'same', itemId: 'input-2', turnId: 'turn-2' });
  const survivingLive = container.children[1];

  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [
    voice('m1', 'user', 'same', 'input-1', 'turn-1'),
  ] });

  assert.deepEqual(container.children.map(row => row.textContent), ['same', 'same']);
  assert.equal(container.children[1], survivingLive);
  assert.equal(container.children[0].dataset.messageId, 'm1');
  assert.equal(container.children[1].dataset.itemId, 'input-2');
  assert.equal(container.children[1].dataset.live, 'true');
});

test('unkeyed live captions stay distinct and remain visible through turn completion', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'same' });
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'same' });

  assert.deepEqual(container.children.map(row => row.textContent), ['same', 'same']);
  assert.equal(container.children.every(row => row.dataset.live === 'true'), true);

  view.finish({ type: 'turn-done', callId: CALL_A, role: 'assistant' });
  assert.deepEqual(container.children.map(row => row.textContent), ['same', 'same']);
  assert.equal(container.children.every(row => row.dataset.complete === 'true'), true);
});

test('an accepted typed receipt renders once and reuses its durable message id', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  const receipt = {
    kind: 'delivery', delivery: 'accepted',
    clientMessageId: '33333333-3333-4333-8333-333333333333',
    messageId: 'typed-1', callId: CALL_A,
  };
  assert.equal(view.appendTyped({ receipt, text: '哪个 API？' }), true);
  const optimistic = container.children[0];

  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [
    typed('typed-1', '哪个 API？', receipt.clientMessageId),
    typed('typed-2', '哪个 API？', '44444444-4444-4444-8444-444444444444'),
  ] });

  assert.equal(container.children.length, 2);
  assert.equal(container.children[0], optimistic);
  assert.deepEqual(container.children.map(row => row.dataset.messageId), ['typed-1', 'typed-2']);
});

test('switching calls clears the old scope and rejects late events and stale replies', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'old', itemId: 'old-item' });
  view.setCall(CALL_B);

  assert.equal(container.children.length, 0);
  assert.equal(view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'late', itemId: 'late-item' }), false);
  assert.equal(view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [] }), false);
  assert.equal(view.appendTyped({ receipt: {
    kind: 'delivery', delivery: 'accepted',
    clientMessageId: '55555555-5555-4555-8555-555555555555', messageId: 'late-typed', callId: CALL_A,
  }, text: 'late typed' }), false);

  view.appendLive({ type: 'transcript', callId: CALL_B, role: 'assistant', text: 'current', itemId: 'current-item' });
  assert.deepEqual(container.children.map(row => row.textContent), ['current']);
});

test('refresh keeps the reading anchor and reports new rows instead of jumping', () => {
  const { view, container, unread } = fixture();
  container.clientHeight = 80;
  container.scrollHeight = 200;
  container.ownerDocument.createElement = () => ({
    dataset: {}, textContent: '', className: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getBoundingClientRect() {
      const top = container.children.indexOf(this) * 40 - container.scrollTop;
      return { top, bottom: top + 40 };
    },
    remove() { container.children = container.children.filter(row => row !== this); },
  });
  container.replaceChildren = (...rows) => {
    container.children = rows;
    container.scrollHeight = rows.length * 40;
    container.scrollTop = 0;
  };
  view.setCall(CALL_A);
  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: true, rows: [
    voice('m1', 'user', 'one', 'i1'),
    voice('m2', 'assistant', 'two', 'i2'),
    voice('m3', 'user', 'three', 'i3'),
    voice('m4', 'assistant', 'four', 'i4'),
  ] });
  container.scrollTop = 40;

  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: true, rows: [
    voice('m2', 'assistant', 'two', 'i2'),
    voice('m3', 'user', 'three', 'i3'),
    voice('m4', 'assistant', 'four', 'i4'),
    voice('m5', 'assistant', 'five', 'i5'),
  ] });

  assert.equal(container.children.find(row => row.dataset.messageId === 'm2').getBoundingClientRect().top, 0);
  assert.equal(unread.at(-1), 1);
  container.scrollTop = container.scrollHeight;
  container.listeners.scroll();
  assert.equal(unread.at(-1), 0);
});

test('turn completion retains the matching caption until its durable source reconciles', () => {
  const { view, container } = fixture();
  view.setCall(CALL_A);
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'first', itemId: 'a', turnId: 'turn-a' });
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'second', itemId: 'b', turnId: 'turn-b' });
  view.finish({ type: 'turn-done', callId: CALL_A, role: 'assistant', turnId: 'turn-a' });
  assert.deepEqual(container.children.map(row => row.textContent), ['first', 'second']);
  assert.equal(container.children[0].dataset.complete, 'true');
  assert.equal(container.children[1].dataset.complete, undefined);
  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [
    voice('m1', 'assistant', 'first', 'a', 'turn-a'),
  ] });
  assert.deepEqual(container.children.map(row => row.textContent), ['first', 'second']);
  assert.equal(container.children[0].dataset.messageId, 'm1');
});

test('a live row becoming durable does not count the same semantic row as unread twice', () => {
  const { view, container, unread } = fixture();
  container.scrollHeight = 200;
  container.clientHeight = 80;
  view.setCall(CALL_A);
  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [] });
  container.scrollTop = 0;
  view.appendLive({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'same',
    itemId: 'output-1', turnId: 'turn-1' });
  assert.equal(unread.at(-1), 1);
  view.load({ kind: 'transcript', scope: scope(CALL_A), hasMore: false, rows: [
    voice('m1', 'assistant', 'same', 'output-1', 'turn-1'),
  ] });
  assert.equal(unread.at(-1), 1);
});
