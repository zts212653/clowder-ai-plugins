import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationHistory } from '../src/conversation-history.mjs';

const body = (revision, complete, continuation = complete ? null : 'body.next') => ({
  revision, complete, continuation,
});
const row = (id, text, projection = body('rev-a', true), overrides = {}) => ({
  id, role: 'assistant', name: '宪宪', text, companionIdentity: undefined,
  inputMessageIds: [], responsePhase: null, body: projection, ...overrides,
});
const page = (messages, overrides = {}) => ({
  kind: 'conversation', v: 2, status: 'available', threadTitle: '猫猫球 · 伴随对话',
  messages, hasMoreOlder: false, olderCursor: null, ...overrides,
});

test('body continuation appends each Host-issued chunk once and never mixes revisions', () => {
  const history = new ConversationHistory();
  history.loadPage(page([row('reply-a', '第一段', body('rev-a', false, 'body.a.1'))]));
  assert.equal(history.bodyContinuation('reply-a'), 'body.a.1');

  history.applyBody('body.a.1', {
    kind: 'conversation-body', v: 2, status: 'available', messageId: 'reply-a', text: '第二段',
    body: body('rev-a', false, 'body.a.2'),
  });
  history.applyBody('body.a.1', {
    kind: 'conversation-body', v: 2, status: 'available', messageId: 'reply-a', text: '第二段',
    body: body('rev-a', false, 'body.a.2'),
  });
  assert.equal(history.message('reply-a').text, '第一段第二段');

  history.applyBody('body.a.2', {
    kind: 'conversation-body', v: 2, status: 'available', messageId: 'reply-a', text: '最后一段',
    body: body('rev-b', true),
  });
  assert.equal(history.message('reply-a').text, '第一段第二段', 'a different revision cannot be appended');
  assert.equal(history.message('reply-a').bodyStatus, 'stale');

  history.loadPage(page([row('reply-a', '新版第一段', body('rev-b', false, 'body.b.1'))]));
  assert.equal(history.message('reply-a').text, '新版第一段');
  assert.equal(history.message('reply-a').body.revision, 'rev-b');
  assert.equal(history.message('reply-a').bodyStatus, 'loading');
});

test('stale and withdrawn body replies cannot masquerade as a completed empty chunk', () => {
  const history = new ConversationHistory();
  history.loadPage(page([
    row('reply-a', '保留的前缀', body('rev-a', false, 'body.a.1')),
    row('reply-b', '会撤回', body('rev-b', false, 'body.b.1')),
  ]));
  history.applyBody('body.a.1', { kind: 'conversation-body', v: 2, status: 'stale' });
  assert.equal(history.message('reply-a').text, '保留的前缀');
  assert.equal(history.message('reply-a').bodyStatus, 'stale');
  assert.equal(history.message('reply-a').body.complete, false);

  history.applyBody('body.b.1', { kind: 'conversation-body', v: 2, status: 'withdrawn' });
  assert.equal(history.message('reply-b'), undefined);
  assert.deepEqual(history.snapshot().messages.map(value => value.id), ['reply-a']);
});

test('older pages prepend without losing the latest page or conflating body and page progress', () => {
  const history = new ConversationHistory();
  history.loadPage(page([row('m3', '三'), row('m4', '四')], {
    hasMoreOlder: true, olderCursor: 'history.before.m3',
  }));
  history.loadPage(page([row('m1', '一'), row('m2', '二')], {
    hasMoreOlder: false, olderCursor: null,
  }), { older: true });
  assert.deepEqual(history.snapshot().messages.map(value => value.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(history.snapshot().hasMoreOlder, false);
  assert.equal(history.snapshot().olderCursor, null);

  history.loadPage(page([row('m4', '四'), row('m5', '五')], {
    hasMoreOlder: true, olderCursor: 'history.before.m4',
  }));
  assert.deepEqual(history.snapshot().messages.map(value => value.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(history.snapshot().hasMoreOlder, false,
    'a latest-page poll cannot replace the cursor after older pages were already consumed');
});

test('a stale history cursor preserves loaded rows and requests a real page refresh', () => {
  const history = new ConversationHistory();
  history.loadPage(page([row('m1', '一')], { hasMoreOlder: true, olderCursor: 'history.before.m1' }));
  assert.equal(history.loadPage({ kind: 'conversation', v: 2, status: 'stale' }, { older: true }), false);
  assert.deepEqual(history.snapshot().messages.map(value => value.id), ['m1']);
  assert.equal(history.snapshot().pageStatus, 'stale');
  assert.equal(history.snapshot().hasMoreOlder, true, 'stale is not an end-of-history receipt');
});

test('permission loss clears protected conversation text without erasing the local error truth', () => {
  const history = new ConversationHistory();
  history.loadPage(page([row('m1', '受保护正文')]));
  history.clearProtected('permission_required');
  assert.deepEqual(history.snapshot().messages, []);
  assert.equal(history.snapshot().pageStatus, 'permission_required');
});
