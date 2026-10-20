import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplyLetterController } from '../src/reply-letter-controller.mjs';

// These rows are a deliberately local fixture projection. The public bridge
// contract is tested separately; this suite protects the renderer state
// machine from inferring reply relationships from time or row position.
const user = (id, text) => ({ id, role: 'user', name: '你', text,
  body: { revision: `revision:${id}`, complete: true, continuation: null },
  inputMessageIds: [], responsePhase: null });
const assistant = (id, text, inputMessageIds = [], complete = true, responsePhase = 'completed') => ({
  id,
  role: 'assistant',
  name: '宪宪',
  text,
  body: { revision: `revision:${id}`, complete, continuation: complete ? null : `continue:${id}` },
  inputMessageIds,
  responsePhase,
});
const receipt = (clientMessageId, messageId, delivery = 'accepted') => ({
  kind: 'delivery', delivery, clientMessageId,
  messageId: delivery === 'accepted' ? messageId : null,
  callId: null,
});

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  const schedule = (callback, delay) => {
    const id = ++nextId;
    tasks.set(id, { callback, dueAt: now + delay });
    return id;
  };
  const cancel = id => tasks.delete(id);
  const advance = milliseconds => {
    const target = now + milliseconds;
    while (true) {
      const ready = [...tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
      if (!ready) break;
      const [id, task] = ready;
      tasks.delete(id);
      now = task.dueAt;
      task.callback();
    }
    now = target;
  };
  return { now: () => now, schedule, cancel, advance, get pending() { return tasks.size; } };
}

function fixture() {
  const clock = fakeClock();
  const renders = [];
  const continuations = [];
  const controller = new ReplyLetterController({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    requestContinuation: value => continuations.push(value),
    render: value => renders.push(structuredClone(value)),
  });
  return { clock, controller, continuations, renders, current: () => renders.at(-1) };
}

test('an accepted letter is collected only by a Host-proven related reply', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '把刚才那一步再讲慢一点');
  assert.equal(f.current().mode, 'sent');
  assert.deepEqual(f.current().pendingInputMessageIds, ['input-a']);

  f.controller.loadHistory([
    user('input-a', '把刚才那一步再讲慢一点'),
    assistant('unrelated', '另一件后台工作的结果', ['some-other-input']),
  ]);
  assert.equal(f.current().mode, 'sent');
  assert.deepEqual(f.current().pendingInputMessageIds, ['input-a']);

  f.controller.loadHistory([
    user('input-a', '把刚才那一步再讲慢一点'),
    assistant('reply-a', '好。我们从第一步慢慢来。', ['input-a']),
  ]);
  assert.equal(f.current().mode, 'reply');
  assert.equal(f.current().reply.id, 'reply-a');
  assert.equal(f.current().letter.text, '把刚才那一步再讲慢一点');
  assert.deepEqual(f.current().pendingInputMessageIds, []);
});

test('relation and body text cannot collect a letter before the source response completes', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '请讲慢一点');
  for (const phase of ['processing', 'failed', 'interrupted', 'canceled']) {
    f.controller.loadHistory([
      assistant('reply-a', '草稿或残段不能算完成', ['input-a'], true, phase),
    ]);
    assert.equal(f.current().mode, 'sent', phase);
    assert.deepEqual(f.current().pendingInputMessageIds, ['input-a'], phase);
    assert.equal(f.current().letter.responsePhase, phase);
    assert.equal(f.current().timer.running, false, phase);
  }

  f.controller.loadHistory([
    assistant('reply-a', '现在是来源确认完成的回答', ['input-a'], true, 'completed'),
  ]);
  assert.equal(f.current().mode, 'reply');
  assert.deepEqual(f.current().pendingInputMessageIds, []);
  assert.equal(f.current().timer.running, true);
});

test('two accepted letters settle independently when replies arrive out of order', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  f.controller.recordDelivery(receipt('client-b', 'input-b'), '第二封');
  f.controller.loadHistory([
    user('input-a', '第一封'), user('input-b', '第二封'),
    assistant('reply-b', '先回第二封', ['input-b']),
  ]);
  assert.equal(f.current().reply.id, 'reply-b');
  assert.deepEqual(f.current().pendingInputMessageIds, ['input-a']);

  f.controller.loadHistory([
    user('input-a', '第一封'), user('input-b', '第二封'),
    assistant('reply-b', '先回第二封', ['input-b']),
    assistant('reply-a', '再回第一封', ['input-a']),
  ]);
  assert.equal(f.current().reply.id, 'reply-a');
  assert.deepEqual(f.current().pendingInputMessageIds, []);
  assert.deepEqual(f.current().settled.map(value => [value.inputMessageId, value.replyId]), [
    ['input-b', 'reply-b'], ['input-a', 'reply-a'],
  ]);
});

test('an unconfirmed delivery keeps its draft and retry identity visible', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', null, 'unconfirmed'), '原草稿');
  assert.equal(f.current().mode, 'compose');
  assert.deepEqual(f.current().draft, {
    text: '原草稿', clientMessageId: 'client-a', settlement: 'unconfirmed',
  });
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '原草稿');
  assert.equal(f.current().mode, 'sent');
  assert.equal(f.current().letter.clientMessageId, 'client-a');
  assert.equal(f.current().draft, null);
});

test('rejected and scope-replaced submissions stay visible but cannot masquerade as retryable', () => {
  const f = fixture();
  f.controller.recordDelivery({
    kind: 'delivery', v: 2, delivery: 'rejected', clientMessageId: 'client-a',
    reason: 'pending_limit', draftRevision: 7,
  }, '第三十三封', { submissionRevision: 7, scopeRef: 'scope-a' });
  assert.equal(f.current().mode, 'compose');
  assert.equal(f.current().draft.settlement, 'pending_limit');
  assert.equal(f.current().draft.submissionRevision, 7);

  f.controller.invalidateDraft({
    clientMessageId: 'client-old', text: '旧聊天里的未确认输入',
    submissionRevision: 2, scopeRef: 'scope-old', reason: 'scope_changed',
  });
  assert.equal(f.current().draft.settlement, 'scope_changed');
  assert.equal(f.current().draft.text, '旧聊天里的未确认输入');
  f.controller.recordDelivery(receipt('client-new', 'input-new'), '人在新聊天里明确重发', {
    submissionRevision: 1, scopeRef: 'scope-new', restored: false,
  });
  assert.equal(f.current().draft, null, 'an explicit new-scope acceptance retires the invalidated presentation');
});

test('a protected history receipt restores accepted identity without inferring it from other rows', () => {
  const f = fixture();
  const protectedUser = {
    ...user('input-a', '恢复这封信'),
    deliveryReceipt: {
      kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId: 'client-a',
      messageId: 'input-a', callId: null,
    },
  };
  f.controller.loadHistory([
    user('unproven', '普通历史行'),
    protectedUser,
    assistant('reply-a', '恢复后的完整回复', ['input-a']),
  ]);
  assert.equal(f.current().mode, 'reply');
  assert.equal(f.current().letter.clientMessageId, 'client-a');
  assert.equal(f.current().letter.inputMessageId, 'input-a');
  assert.equal(f.current().reply.id, 'reply-a');
  assert.equal(f.current().pendingInputMessageIds.includes('unproven'), false,
    'row presence alone must never become accepted truth');
});

test('a related partial body requests continuation and cannot start the dismissal timer', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '讲完整一点');
  f.controller.loadHistory([
    user('input-a', '讲完整一点'),
    assistant('reply-a', '这里只是第一段', ['input-a'], false),
  ]);
  assert.equal(f.current().mode, 'reply');
  assert.equal(f.current().reply.complete, false);
  assert.equal(f.current().timer.running, false);
  assert.equal(f.clock.pending, 0);
  assert.deepEqual(f.continuations, [{ messageId: 'reply-a', continuation: 'continue:reply-a' }]);

  f.controller.loadHistory([
    user('input-a', '讲完整一点'),
    assistant('reply-a', '这是读取完成后的完整回答。', ['input-a'], true),
  ]);
  assert.equal(f.current().reply.complete, true);
  assert.equal(f.current().timer.running, true);
  assert.equal(f.clock.pending, 1);
});

test('a transient body read failure releases only that continuation for a later retry', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '讲完整一点');
  const rows = [assistant('reply-a', '第一段', ['input-a'], false)];
  f.controller.loadHistory(rows);
  assert.deepEqual(f.continuations, [{ messageId: 'reply-a', continuation: 'continue:reply-a' }]);
  f.controller.releaseContinuation('reply-a', 'continue:reply-a');
  f.controller.loadHistory(rows);
  assert.deepEqual(f.continuations, [
    { messageId: 'reply-a', continuation: 'continue:reply-a' },
    { messageId: 'reply-a', continuation: 'continue:reply-a' },
  ]);
});

test('a withdrawn completed reply clears protected body but keeps the accepted letter truth', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '原问题');
  f.controller.loadHistory([assistant('reply-a', '稍后被撤回的回答', ['input-a'])]);
  assert.equal(f.current().mode, 'reply');
  f.controller.withdrawReply('reply-a');
  assert.equal(f.current().mode, 'sent');
  assert.equal(f.current().reply, null);
  assert.equal(f.current().letter.inputMessageId, 'input-a');
  assert.equal(f.current().letter.responsePhase, 'withdrawn');
  assert.deepEqual(f.current().pendingInputMessageIds, ['input-a']);
  assert.equal(f.current().history.some(value => value.id === 'reply-a'), false);
});

test('hover, focus and scrolling pause one timer; pinning replaces it with an explicit close', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '一句');
  f.controller.loadHistory([assistant('reply-a', '八个字的完整回复', ['input-a'])]);
  const duration = f.current().timer.remainingMs;
  assert.ok(duration >= 6_000 && duration <= 30_000);

  f.clock.advance(1_000);
  f.controller.pause('hover');
  const pausedAt = f.current().timer.remainingMs;
  f.clock.advance(duration + 1_000);
  assert.equal(f.current().mode, 'reply');
  assert.equal(f.current().timer.remainingMs, pausedAt);
  f.controller.pause('focus');
  f.controller.resume('hover');
  assert.equal(f.current().timer.running, false);
  f.controller.resume('focus');
  assert.equal(f.current().timer.running, true);

  f.controller.pin();
  assert.equal(f.current().retained, true);
  assert.equal(f.current().timer.running, false);
  assert.equal(f.clock.pending, 0);
  f.clock.advance(60_000);
  assert.equal(f.current().mode, 'reply');
  f.controller.close();
  assert.equal(f.current().mode, 'idle');
  assert.equal(f.current().history.some(row => row.id === 'reply-a'), true,
    'closing the presentation must not delete or mark the Host message');
});

test('new replies do not pull a reader away from older history', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  f.controller.loadHistory([assistant('reply-a', '第一封回复', ['input-a'])]);
  f.controller.openHistory('reply-a');
  assert.equal(f.current().mode, 'history');
  assert.equal(f.current().selectedMessageId, 'reply-a');

  f.controller.recordDelivery(receipt('client-b', 'input-b'), '第二封');
  f.controller.loadHistory([
    assistant('reply-a', '第一封回复', ['input-a']),
    assistant('reply-b', '第二封回复', ['input-b']),
  ]);
  assert.equal(f.current().mode, 'history');
  assert.equal(f.current().selectedMessageId, 'reply-a');
  assert.equal(f.current().hasNewer, true);

  f.controller.returnLatest();
  assert.equal(f.current().selectedMessageId, 'reply-b');
  assert.equal(f.current().hasNewer, false);
});

test('retained reply history is read-only without changing the shared history selection', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  f.controller.loadHistory([assistant('reply-a', '第一封回复', ['input-a'])]);
  f.controller.pin();

  f.controller.openReplyHistory();
  assert.equal(f.current().mode, 'history');
  assert.equal(f.current().historyPresentation, 'reply');
  assert.equal(f.current().selectedMessageId, 'reply-a');

  f.controller.openHistory('reply-a');
  assert.equal(f.current().mode, 'history');
  assert.equal(f.current().historyPresentation, 'conversation');
  assert.equal(f.current().selectedMessageId, 'reply-a');
});

test('settled replies cannot steal an explicit compose or a newer sent letter', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  const firstRows = [assistant('reply-a', '第一封回复', ['input-a'])];
  f.controller.loadHistory(firstRows);
  assert.equal(f.current().mode, 'reply');

  f.controller.openHistory();
  f.controller.openCompose();
  f.controller.loadHistory(firstRows);
  assert.equal(f.current().mode, 'compose', 'an old settled pair must not close a new composer');

  f.controller.recordDelivery(receipt('client-b', 'input-b'), '第二封');
  assert.equal(f.current().mode, 'sent');
  f.controller.loadHistory(firstRows);
  assert.equal(f.current().mode, 'sent', 'an old settled pair must not replace a newer in-flight letter');
  assert.equal(f.current().letter.inputMessageId, 'input-b');

  f.controller.loadHistory([
    ...firstRows,
    assistant('reply-b', '第二封回复', ['input-b']),
  ]);
  assert.equal(f.current().mode, 'reply');
  assert.equal(f.current().reply.id, 'reply-b');
});

test('a reply settling while the user composes stays available in anchored history', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  f.controller.openCompose();
  f.controller.loadHistory([assistant('reply-a', '第一封回复', ['input-a'])]);
  assert.equal(f.current().mode, 'compose');
  assert.deepEqual(f.current().pendingInputMessageIds, []);
  assert.deepEqual(f.current().settled, [{ inputMessageId: 'input-a', replyId: 'reply-a' }]);

  f.controller.openHistory();
  assert.equal(f.current().selectedMessageId, 'reply-a');
  assert.equal(f.current().hasNewer, false);
});

test('history opened without an explicit message anchors the newest known reply', () => {
  const f = fixture();
  f.controller.recordDelivery(receipt('client-a', 'input-a'), '第一封');
  const rows = [assistant('reply-a', '第一封回复', ['input-a'])];
  f.controller.loadHistory(rows);
  f.controller.close();
  f.controller.openHistory();
  assert.equal(f.current().selectedMessageId, 'reply-a');
  f.controller.loadHistory(rows);
  assert.equal(f.current().hasNewer, false, 'the reply present when history opens is not newer than itself');
});
