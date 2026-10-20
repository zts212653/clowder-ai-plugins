import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplyLetterView } from '../src/reply-letter-view.mjs';

function node(id) {
  const listeners = new Map();
  return {
    id,
    hidden: false,
    value: '',
    textContent: '',
    dataset: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    fire(name, value = {}) { return listeners.get(name)?.(value); },
  };
}

function fixture() {
  const ids = [
    'chat', 'chat-history-header', 'chat-name', 'chat-history-dismiss', 'reply-history-close',
    'chat-transcript-shell', 'chat-transcript', 'compose', 'message',
    'chat-feedback', 'chat-status', 'chat-connection-status', 'chat-scope', 'reply-sent', 'reply-sent-status',
    'reply-letter-text', 'reply-card', 'reply-input-text', 'reply-body',
    'reply-body-status', 'reply-retain', 'reply-close', 'reply-history-open',
    'reply-return-latest', 'reply-retry',
  ];
  const nodes = new Map(ids.map(id => [id, node(id)]));
  const document = { getElementById: id => nodes.get(id) };
  const calls = [];
  const controller = {
    pause: reason => calls.push(['pause', reason]),
    resume: reason => calls.push(['resume', reason]),
    pin: () => calls.push(['pin']),
    close: () => calls.push(['close']),
    openHistory: () => calls.push(['history']),
    openReplyHistory: () => calls.push(['reply-history']),
    returnLatest: () => calls.push(['latest']),
  };
  const retries = [];
  const view = new ReplyLetterView({ document, controller, retry: draft => retries.push(draft) });
  return { calls, nodes, retries, view };
}

const base = {
  mode: 'idle', draft: null, letter: null, reply: null, retained: false,
  hasNewer: false, historyPresentation: null, timer: { running: false, remainingMs: 0 },
};

test('an unconfirmed retry keeps the original identity without erasing a newer local draft', () => {
  const f = fixture();
  f.nodes.get('message').value = '等待期间新写的一句';
  const draft = { text: '原来没确认的那句', clientMessageId: 'client-a', settlement: 'unconfirmed' };
  f.view.render({ ...base, mode: 'compose', draft });

  assert.equal(f.nodes.get('compose').hidden, false);
  assert.equal(f.nodes.get('chat-feedback').hidden, false);
  assert.equal(f.nodes.get('chat-status').textContent, '发送结果未确认');
  assert.equal(f.nodes.get('message').value, '等待期间新写的一句');
  f.nodes.get('reply-retry').onclick();
  assert.deepEqual(f.retries, [draft]);
});

test('an empty compose state does not reserve a feedback row', () => {
  const f = fixture();
  f.view.render({ ...base, mode: 'compose' });
  assert.equal(f.nodes.get('compose').hidden, false);
  assert.equal(f.nodes.get('chat-feedback').hidden, true);
});

test('scope change and deterministic rejection are honest non-retry states', () => {
  const f = fixture();
  f.view.render({ ...base, mode: 'compose', draft: {
    text: '旧聊天里的未确认输入', clientMessageId: 'client-old', settlement: 'scope_changed',
  } });
  assert.equal(f.nodes.get('reply-retry').hidden, true);
  assert.equal(f.nodes.get('chat-status').textContent, '原聊天已变化 · 这条消息没有重发');

  f.view.render({ ...base, mode: 'compose', draft: {
    text: '第三十三封', clientMessageId: 'client-a', settlement: 'pending_limit',
  } });
  assert.equal(f.nodes.get('reply-retry').hidden, true);
  assert.equal(f.nodes.get('chat-status').textContent, '待确认消息已达 32 条 · 这条没有发送');
});

test('a sent letter distinguishes waiting, processing and failed source states', () => {
  const f = fixture();
  const letter = { text: '把那一步讲慢一点', clientMessageId: 'client-a', inputMessageId: 'input-a' };
  f.view.render({ ...base, mode: 'sent', letter });
  assert.equal(f.nodes.get('reply-sent').hidden, false);
  assert.equal(f.nodes.get('reply-letter-text').hidden, true);
  assert.equal(f.nodes.get('reply-letter-text').textContent, '');
  assert.equal(f.nodes.get('reply-sent-status').textContent, '已发送');

  f.view.render({ ...base, mode: 'sent', letter: { ...letter, responsePhase: 'processing' } });
  assert.equal(f.nodes.get('reply-sent-status').textContent, '正在回复');
  f.view.render({ ...base, mode: 'sent', letter: { ...letter, responsePhase: 'failed' } });
  assert.equal(f.nodes.get('reply-sent-status').textContent, '回复失败');
});

test('a reply loads its complete body before offering countdown or explicit retention', () => {
  const f = fixture();
  const letter = { text: '讲完整一点', clientMessageId: 'client-a', inputMessageId: 'input-a' };
  f.view.render({ ...base, mode: 'reply', letter,
    reply: { id: 'reply-a', text: '第一段', complete: false, responsePhase: 'completed' } });
  assert.equal(f.nodes.get('reply-card').hidden, false);
  assert.equal(f.nodes.get('reply-input-text').textContent, '讲完整一点');
  assert.equal(f.nodes.get('reply-body').textContent, '第一段');
  assert.equal(f.nodes.get('reply-body-status').textContent, '正在载入完整回复…');
  assert.equal(f.nodes.get('reply-retain').hidden, true);
  assert.equal(f.nodes.get('reply-close').hidden, true);

  f.view.render({ ...base, mode: 'reply', letter,
    reply: { id: 'reply-a', text: '读取完成后的完整回复', complete: true, responsePhase: 'completed' },
    timer: { running: true, remainingMs: 8_000 } });
  assert.equal(f.nodes.get('reply-body-status').textContent, '');
  assert.equal(f.nodes.get('reply-retain').hidden, false);
  assert.equal(f.nodes.get('reply-retain').style.values['--reply-visible-ms'], '8000ms');
  f.nodes.get('reply-retain').onclick();
  assert.deepEqual(f.calls.at(-1), ['pin']);

  f.view.render({ ...base, mode: 'reply', retained: true, letter,
    reply: { id: 'reply-a', text: '读取完成后的完整回复', complete: true, responsePhase: 'completed' } });
  assert.equal(f.nodes.get('reply-retain').hidden, true);
  assert.equal(f.nodes.get('reply-close').hidden, false);
  f.nodes.get('reply-history-open').onclick();
  assert.deepEqual(f.calls.at(-1), ['reply-history']);
  f.nodes.get('reply-close').onclick();
  assert.deepEqual(f.calls.at(-1), ['close']);
});

test('retained reply history is read-only and reports newer rows without moving selection', () => {
  const f = fixture();
  f.nodes.get('chat-connection-status').textContent = '聊天记录暂未更新';
  f.view.render({ ...base, mode: 'history', historyPresentation: 'reply', hasNewer: true,
    draftNotice: 'unavailable' });
  assert.equal(f.nodes.get('chat-history-header').hidden, true);
  assert.equal(f.nodes.get('chat-transcript-shell').hidden, false);
  assert.equal(f.nodes.get('chat-transcript').hidden, false);
  assert.equal(f.nodes.get('compose').hidden, true);
  assert.equal(f.nodes.get('chat-feedback').hidden, true);
  assert.equal(f.nodes.get('chat-connection-status').hidden, true);
  assert.equal(f.nodes.get('chat-scope').hidden, true);
  assert.equal(f.nodes.get('chat-name').hidden, true);
  assert.equal(f.nodes.get('chat-history-dismiss').hidden, true);
  assert.equal(f.nodes.get('reply-history-close').hidden, false);
  assert.equal(f.nodes.get('reply-return-latest').hidden, false);
  f.nodes.get('reply-return-latest').onclick();
  assert.deepEqual(f.calls.at(-1), ['latest']);
});

test('ordinary conversation history keeps its composer and scope', () => {
  const f = fixture();
  f.view.render({ ...base, mode: 'history', historyPresentation: 'conversation' });
  assert.equal(f.nodes.get('chat-transcript-shell').hidden, false);
  assert.equal(f.nodes.get('compose').hidden, false);
  assert.equal(f.nodes.get('chat-scope').hidden, false);
  assert.equal(f.nodes.get('chat-connection-status').hidden, false);
  assert.equal(f.nodes.get('chat-name').hidden, false);
  assert.equal(f.nodes.get('chat-history-dismiss').hidden, false);
  assert.equal(f.nodes.get('reply-history-close').hidden, true);
});

test('hover, focus, pointer and scroll all pause the same controller timer', () => {
  const f = fixture();
  const root = f.nodes.get('reply-card');
  root.fire('pointerenter'); root.fire('pointerleave');
  root.fire('focusin'); root.fire('focusout', { relatedTarget: null });
  root.fire('wheel'); root.fire('pointerdown'); root.fire('pointerup');
  assert.deepEqual(f.calls, [
    ['pause', 'hover'], ['resume', 'hover'],
    ['pause', 'focus'], ['resume', 'focus'],
    ['pause', 'scroll'], ['pause', 'pointer'], ['resume', 'pointer'],
  ]);
});
