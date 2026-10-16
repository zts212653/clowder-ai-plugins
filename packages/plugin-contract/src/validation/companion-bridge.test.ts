import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCompanionCommand, validateCompanionReply, validateCompanionEvent } from './companion-bridge.js';

test('cat-first controls stay bounded to this window and its existing conversation', () => {
  for (const command of [{ kind: 'view.layout', panel: 'menu', width: 204, height: 250 },
    { kind: 'view.drag', phase: 'start' }, { kind: 'view.hide' }, { kind: 'conversation.read' }]) {
    assert.equal(validateCompanionCommand(command), true);
    for (const field of ['windowId', 'threadId', 'userId', 'x', 'url']) {
      assert.equal(validateCompanionCommand({ ...command, [field]: 'other' }), false);
    }
  }
  for (const width of [0, -1, 100000, 200.5]) assert.equal(validateCompanionCommand({ kind: 'view.layout', panel: 'menu', width, height: 250 }), false);
  assert.equal(validateCompanionCommand({ kind: 'view.drag', phase: 'unlimited' }), false);
  assert.equal(validateCompanionCommand({ kind: 'view.layout', panel: 'bubble', width: 240, height: 80 }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation', threadTitle: '猫猫球 · 伴随对话', messages: [{ id: 'real-message', role: 'user', text: '你好', name: '你' }], hasMore: false }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation', messages: [], hasMore: false }), false);
  assert.equal(validateCompanionEvent({ kind: 'view-dismiss' }), true);
});

test('conversation v2 separates history progress, response phase and body progress', () => {
  const body = { revision: 'sha256:body-a', complete: false, continuation: 'body.next_A-1' };
  const row = {
    id: 'assistant-a', role: 'assistant', name: '宪宪', text: '第一段',
    inputMessageIds: ['input-a'], responsePhase: 'completed', body,
  };
  const page = {
    kind: 'conversation', v: 2, status: 'available', threadTitle: '猫猫球 · 伴随对话',
    messages: [row], hasMoreOlder: true, olderCursor: 'history.before_A-1',
  };

  assert.equal(validateCompanionCommand({ kind: 'conversation.read', v: 2 }), true);
  assert.equal(validateCompanionCommand({ kind: 'conversation.read', v: 2, before: 'history.before_A-1', limit: 20 }), true);
  assert.equal(validateCompanionCommand({ kind: 'conversation.body.read', v: 2, continuation: 'body.next_A-1' }), true);
  for (const limit of [0, 33, 1.5])
    assert.equal(validateCompanionCommand({ kind: 'conversation.read', v: 2, limit }), false);
  assert.equal(validateCompanionCommand({ kind: 'conversation.read', v: 2, threadId: 'renderer-choice' }), false);
  assert.equal(validateCompanionCommand({ kind: 'conversation.body.read', v: 2, continuation: 'body.next_A-1', messageId: 'assistant-a' }), false);

  assert.equal(validateCompanionReply(page), true);
  assert.equal(validateCompanionReply({ ...page, messages: [{ ...row, responsePhase: 'processing', body: { ...body, complete: true, continuation: null } }] }), true,
    'a complete body projection must not imply that the source response completed');
  assert.equal(validateCompanionReply({ ...page, messages: [{ ...row, responsePhase: null, inputMessageIds: [] }] }), true,
    'legacy or unproven rows remain readable without a fabricated relation');
  assert.equal(validateCompanionReply({ ...page, hasMoreOlder: false, olderCursor: null }), true);
  assert.equal(validateCompanionReply({ ...page, hasMoreOlder: false }), false);
  assert.equal(validateCompanionReply({ ...page, hasMoreOlder: false, olderCursor: 'history.before_A-1' }), false);
  assert.equal(validateCompanionReply({ ...page, messages: [{ ...row, body: { ...body, complete: false, continuation: null } }] }), false);
  assert.equal(validateCompanionReply({ ...page, messages: [{ ...row, body: { ...body, complete: true, continuation: 'body.next_A-1' } }] }), false);

  assert.equal(validateCompanionReply({ kind: 'conversation', v: 2, status: 'stale' }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation', v: 2, status: 'stale', messages: [] }), false);
  assert.equal(validateCompanionReply({
    kind: 'conversation-body', v: 2, status: 'available', messageId: 'assistant-a', text: '第二段',
    body: { revision: 'sha256:body-a', complete: true, continuation: null },
  }), true);
  for (const status of ['stale', 'withdrawn'])
    assert.equal(validateCompanionReply({ kind: 'conversation-body', v: 2, status }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation-body', v: 2, status: 'withdrawn', text: '' }), false);

  assert.equal(validateCompanionReply({
    kind: 'conversation', v: 2, threadTitle: 'old branch must stay strict', messages: [], hasMore: false,
  }), false, 'adding v:2 cannot silently extend the legacy conversation branch');
  assert.equal(validateCompanionReply({ kind: 'error', code: 'permission_required' }), true);
});

test('conversation drafts and durable text submissions stay revision-bound', () => {
  const clientMessageId = '6d01d254-1e3b-4588-a352-756449e95025';
  const scopeRef = 'companion-scope_A-1';
  const accepted = {
    kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId,
    messageId: 'message-1', callId: null,
  };
  const unconfirmed = {
    kind: 'delivery', v: 2, delivery: 'unconfirmed', clientMessageId,
    messageId: null, callId: null,
  };

  assert.equal(validateCompanionCommand({ kind: 'conversation.draft.read', v: 1 }), true);
  assert.equal(validateCompanionCommand({
    kind: 'conversation.draft.save', v: 1, scopeRef, expectedRevision: 7, text: '继续写',
  }), true);
  assert.equal(validateCompanionCommand({
    kind: 'conversation.draft.save', v: 1, scopeRef, expectedRevision: 7, text: '',
  }), true, 'clearing a writable canonical draft remains a valid CAS write');
  assert.equal(validateCompanionCommand({
    kind: 'text', v: 2, scopeRef, text: '请继续', clientMessageId, submissionRevision: 7,
  }), true);
  assert.equal(validateCompanionCommand({ kind: 'conversation.delivery.read', v: 1, scopeRef, clientMessageId }), true);
  for (const command of [
    { kind: 'conversation.draft.read' },
    { kind: 'conversation.draft.save', v: 1, scopeRef, expectedRevision: -1, text: '' },
    { kind: 'conversation.draft.save', v: 1, scopeRef, expectedRevision: 7, text: 'x'.repeat(8001) },
    { kind: 'conversation.draft.save', v: 1, expectedRevision: 7, text: '' },
    { kind: 'text', v: 2, scopeRef, text: 'x'.repeat(8001), clientMessageId, submissionRevision: 7 },
    { kind: 'text', v: 2, scopeRef, text: '请继续', clientMessageId, submissionRevision: -1 },
    { kind: 'text', v: 2, text: '请继续', clientMessageId, submissionRevision: 7 },
    { kind: 'conversation.delivery.read', v: 1, scopeRef, clientMessageId, text: 'renderer claim' },
    { kind: 'conversation.delivery.read', v: 1, clientMessageId },
  ]) assert.equal(validateCompanionCommand(command), false);

  const available = {
    kind: 'conversation-draft', v: 1, status: 'available', scopeRef, revision: 7,
    text: '一段可恢复的草稿', writable: true,
    submissions: [{ clientMessageId, text: '请继续', submissionRevision: 6, receipt: unconfirmed }],
  };
  assert.equal(validateCompanionReply(available), true);
  assert.equal(validateCompanionReply({ ...available, text: 'x'.repeat(100001) }), false);
  assert.equal(validateCompanionReply({ ...available, text: 'x'.repeat(8001), writable: true }), false);
  assert.equal(validateCompanionReply({ ...available, text: 'x'.repeat(8001), writable: false }), true);
  assert.equal(validateCompanionReply({ ...available, submissions: [
    available.submissions[0], available.submissions[0],
  ] }), false, 'one intent identity occupies one recovery slot');
  assert.equal(validateCompanionReply({ ...available, submissions: [{
    ...available.submissions[0], receipt: { ...unconfirmed, clientMessageId:
      '863adf11-9fa3-4156-93af-94f7d6022d85' },
  }] }), false, 'the receipt identity must match its submission');
  assert.equal(validateCompanionReply({ ...available, submissions: [
    { ...available.submissions[0], receipt: accepted },
    { ...available.submissions[0], clientMessageId: '863adf11-9fa3-4156-93af-94f7d6022d85',
      receipt: { ...accepted, clientMessageId: '863adf11-9fa3-4156-93af-94f7d6022d85' } },
  ] }), false, 'only the most recent accepted recovery receipt is projected');
  assert.equal(validateCompanionReply({ ...available, submissions: [
    { ...available.submissions[0], receipt: {
      kind: 'delivery', v: 2, delivery: 'rejected', clientMessageId,
      reason: 'pending_limit', draftRevision: 7,
    } },
  ] }), false, 'rejected attempts are not durable draft submissions');
  assert.equal(validateCompanionReply({ ...available, submissions: Array.from({ length: 33 }, () => available.submissions[0]) }), false);
  assert.equal(validateCompanionReply({ kind: 'conversation-draft', v: 1, status: 'conflict', revision: 8 }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation-draft', v: 1, status: 'readonly', revision: 8 }), true);
  assert.equal(validateCompanionReply({ kind: 'conversation-draft', v: 1, status: 'readonly', revision: 8, text: '' }), false);

  assert.equal(validateCompanionReply(accepted), true);
  assert.equal(validateCompanionReply(unconfirmed), true);
  for (const reason of ['draft_changed', 'unsupported_draft', 'pending_limit']) {
    assert.equal(validateCompanionReply({
      kind: 'delivery', v: 2, delivery: 'rejected', clientMessageId, reason, draftRevision: 7,
    }), true);
  }
  assert.equal(validateCompanionReply({
    kind: 'delivery', v: 2, delivery: 'rejected', clientMessageId,
    reason: 'busy', draftRevision: 7,
  }), false);
});

test('history v2 carries only the Host-protected accepted receipt for the same user message', () => {
  const clientMessageId = '6d01d254-1e3b-4588-a352-756449e95025';
  const receipt = {
    kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId,
    messageId: 'input-a', callId: null,
  };
  const userRow = {
    id: 'input-a', role: 'user', name: '你', text: '请继续',
    inputMessageIds: [], responsePhase: null,
    body: { revision: 'sha256:input-a', complete: true, continuation: null },
    deliveryReceipt: receipt,
  };
  const page = {
    kind: 'conversation', v: 2, status: 'available', threadTitle: '猫猫球 · 伴随对话',
    messages: [userRow], hasMoreOlder: false, olderCursor: null,
  };
  assert.equal(validateCompanionReply(page), true);
  assert.equal(validateCompanionReply({ ...page, messages: [{
    ...userRow, deliveryReceipt: { ...receipt, messageId: 'another-message' },
  }] }), false);
  assert.equal(validateCompanionReply({ ...page, messages: [{
    ...userRow, deliveryReceipt: { ...receipt, delivery: 'unconfirmed', messageId: null },
  }] }), false);
  assert.equal(validateCompanionReply({ ...page, messages: [{
    ...userRow, role: 'assistant', inputMessageIds: ['input-a'], responsePhase: 'completed',
  }] }), false);
});

test('call transcript is a Host-bound read with stable source identity', () => {
  assert.equal(validateCompanionCommand({ kind: 'transcript.read' }), true);
  assert.equal(validateCompanionCommand({ kind: 'transcript.read', callId: 'renderer-chosen' }), false,
    'the renderer cannot select a call');
  assert.equal(validateCompanionCommand({ kind: 'view.layout', panel: 'transcript', width: 420, height: 500 }), true);

  const callId = '863adf11-9fa3-4156-93af-94f7d6022d85';
  const reply = {
    kind: 'transcript',
    scope: { callId, realtimeSessionId: 'rtc-session-1' },
    rows: [
      {
        messageId: 'voice-message-1', role: 'assistant', text: '翻译结果',
        source: {
          kind: 'voice', nativeThreadId: 'native-thread-1', realtimeSessionId: 'rtc-session-1',
          nativeItemId: 'item-1', nativeTurnId: 'turn-1',
        },
      },
      {
        messageId: 'typed-message-1', role: 'user', text: '请解释这一句',
        source: { kind: 'typed', clientMessageId: '6d01d254-1e3b-4588-a352-756449e95025', callId },
      },
    ],
    hasMore: false,
  };
  assert.equal(validateCompanionReply(reply), true);
  assert.equal(validateCompanionReply({ ...reply, rows: [
    { ...reply.rows[1], role: 'assistant' },
  ] }), false, 'typed rows are always the owner input');
  assert.equal(validateCompanionReply({ ...reply, rows: [
    { ...reply.rows[0], source: { ...reply.rows[0].source, realtimeSessionId: 'another-session' } },
  ] }), false, 'voice rows must belong to the returned scope');
  assert.equal(validateCompanionReply({ ...reply, rows: [
    { ...reply.rows[1], source: { ...reply.rows[1].source, callId: 'cc734568-0695-42e6-a783-ec4708f31979' } },
  ] }), false, 'typed rows must belong to the returned call');
  assert.equal(validateCompanionReply({ ...reply, rows: [reply.rows[0], reply.rows[0]] }), false,
    'one durable message cannot occupy two transcript positions');
  assert.equal(validateCompanionReply({ ...reply, rows: [
    { ...reply.rows[0], text: 'a'.repeat(16000) },
    { ...reply.rows[1], text: 'b'.repeat(8001) },
  ] }), false, 'the whole transcript reply stays inside the 24000-character budget');
});

test('visible-text observations expose only a current call fence and one correlatable reference', () => {
  const callId = '863adf11-9fa3-4156-93af-94f7d6022d85';
  const observedAt = 1_791_804_000_000;
  const voice = {
    kind: 'presentation.observe', event: 'first_text_visible', observedAt, callId,
    reference: { kind: 'native-item', nativeItemId: 'output-item-1' },
  };
  const durable = {
    kind: 'presentation.observe', event: 'first_text_visible', observedAt, callId,
    reference: { kind: 'message', messageId: 'message-1' },
  };

  assert.equal(validateCompanionCommand(voice), true);
  assert.equal(validateCompanionCommand(durable), true);
  for (const field of ['text', 'realtimeSessionId', 'generation', 'ownerId', 'audio']) {
    assert.equal(validateCompanionCommand({ ...voice, [field]: 'renderer-claim' }), false, field);
  }
  assert.equal(validateCompanionCommand({ ...voice, callId: 'not-a-call' }), false);
  assert.equal(validateCompanionCommand({ ...voice, observedAt: -1 }), false);
  assert.equal(validateCompanionCommand({ ...voice, event: 'painted' }), false);
  assert.equal(validateCompanionCommand({ ...voice, reference: {
    kind: 'native-item', nativeItemId: 'output-item-1', messageId: 'message-1',
  } }), false, 'one observation cannot claim two source identities');
  assert.equal(validateCompanionCommand({ ...durable, reference: {
    kind: 'message', messageId: 'message-1', text: 'private subtitle',
  } }), false, 'the correlation reference is closed and carries no content');
  for (const value of ['   ', 'item\nforged', 'x'.repeat(257)]) {
    assert.equal(validateCompanionCommand({ ...voice, reference: {
      kind: 'native-item', nativeItemId: value,
    } }), false, 'native item references are bounded single-line opaque values');
    assert.equal(validateCompanionCommand({ ...durable, reference: {
      kind: 'message', messageId: value,
    } }), false, 'message references are bounded single-line opaque values');
  }
});

test('presentation references accept exactly the same single-line ids as their source surfaces', () => {
  const callId = '863adf11-9fa3-4156-93af-94f7d6022d85';
  const clientMessageId = '6d01d254-1e3b-4588-a352-756449e95025';
  const spaced = 'opaque id';
  assert.equal(validateCompanionReply({
    kind: 'transcript', scope: { callId, realtimeSessionId: 'rtc-1' }, hasMore: false,
    rows: [{ messageId: spaced, role: 'assistant', text: 'answer', source: {
      kind: 'voice', nativeThreadId: 'thread-1', realtimeSessionId: 'rtc-1', nativeItemId: 'item-1',
    } }],
  }), false);
  assert.equal(validateCompanionReply({
    kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: spaced, callId,
  }), false);
  assert.equal(validateCompanionEvent({
    kind: 'audio', type: 'transcript', callId, role: 'assistant', text: 'answer', itemId: spaced,
  }), false);
});

test('typed delivery receipts preserve retry and durable message identities', () => {
  const callId = '863adf11-9fa3-4156-93af-94f7d6022d85';
  const clientMessageId = '6d01d254-1e3b-4588-a352-756449e95025';
  assert.equal(validateCompanionReply({
    kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: 'message-1', callId,
  }), true);
  assert.equal(validateCompanionReply({
    kind: 'delivery', delivery: 'unconfirmed', clientMessageId, messageId: null, callId,
  }), true);
  assert.equal(validateCompanionReply({ kind: 'delivery', delivery: 'accepted' }), false,
    'legacy receipts cannot support deterministic transcript reconciliation');
  assert.equal(validateCompanionReply({
    kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: null, callId,
  }), false, 'accepted means the durable message identity is known');
});

test('real-time audio events are scoped to the current call', () => {
  const callId = '863adf11-9fa3-4156-93af-94f7d6022d85';
  assert.equal(validateCompanionEvent({
    kind: 'audio', type: 'transcript', callId, role: 'assistant', text: '实时字幕', itemId: 'item-1',
  }), true);
  assert.equal(validateCompanionEvent({
    kind: 'audio', type: 'transcript', role: 'assistant', text: '旧通话字幕', itemId: 'item-1',
  }), false);
  assert.equal(validateCompanionEvent({ kind: 'audio', type: 'connected', callId }), true);
  assert.equal(validateCompanionEvent({ kind: 'audio', type: 'connected' }), false);
});

test('companion settings are Host-bound single-field updates with explicit settlement truth', () => {
  assert.equal(validateCompanionCommand({ kind: 'settings.read' }), true);
  assert.equal(validateCompanionCommand({ kind: 'settings.read', ownerId: 'renderer-choice' }), false);
  assert.equal(validateCompanionCommand({ kind: 'view.layout', panel: 'settings', width: 360, height: 478 }), true);

  const updates = [
    { kind: 'settings.update', field: 'dutyCatProfileId', value: 'fable-5' },
    { kind: 'settings.update', field: 'skin', value: 'xianxian-codex' },
    { kind: 'settings.update', field: 'ballSize', value: 96 },
    { kind: 'settings.update', field: 'behaviorEnabled', value: false },
    { kind: 'settings.update', field: 'proactivePolicy', value: 'ambient' },
    { kind: 'settings.update', field: 'personaTone', value: '温暖、简短、不啰嗦' },
    { kind: 'settings.update', field: 'householdReadsAllowed', value: false },
  ];
  for (const update of updates) {
    assert.equal(validateCompanionCommand(update), true, update.field);
    for (const selector of ['ownerId', 'instanceId', 'url', 'callId']) {
      assert.equal(validateCompanionCommand({ ...update, [selector]: 'renderer-choice' }), false, selector);
    }
  }
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'ballSize', value: 42 }), false);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'ballSize', value: 193 }), false);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'personaTone', value: 'warm\ninjected' }), false);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'personaTone', value: '   ' }), false);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'personaTone', value: 'warm\u2028injected' }), false);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'enabled', value: false }), false,
    'legacy web visibility is not plugin lifecycle');
  assert.equal(validateCompanionCommand({ ...updates[1], behaviorEnabled: true }), false,
    'one command cannot smuggle a second setting');

  const settings = {
    kind: 'settings', status: 'available',
    values: {
      dutyCatProfileId: 'fable-5', skin: 'xianxian-codex', ballSize: 72,
      behaviorEnabled: true, proactivePolicy: 'quiet-badge',
      personaTone: '温暖、简短、不啰嗦', householdReadsAllowed: true,
    },
    companions: [
      { catProfileId: 'fable-5', displayName: '宪宪', available: true },
      { catProfileId: 'codex-sol', displayName: '砚砚', available: false },
    ],
    selectedCompanionStatus: 'available',
  };
  assert.equal(validateCompanionReply(settings), true);
  assert.equal(validateCompanionReply({ ...settings, selectedCompanionStatus: 'unavailable',
    values: { ...settings.values, dutyCatProfileId: 'retired-cat' } }), true,
  'a stale saved selection remains visible instead of silently becoming the first roster entry');
  assert.equal(validateCompanionReply({ kind: 'settings', status: 'unavailable', reason: 'host_upgrade_required' }), true);
  assert.equal(validateCompanionReply({ ...settings, values: { ...settings.values, ballSize: 12 } }), false);
  assert.equal(validateCompanionReply({ ...settings, values: { ...settings.values, personaTone: '   ' } }), true,
    'reads preserve legacy saved values even though new updates reject blank input');

  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'personaTone', outcome: 'saved', callStatus: 'unchanged', applies: 'next_call',
  }), true);
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'behaviorEnabled', outcome: 'saved', callStatus: 'unchanged', applies: 'now',
  }), true);
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'householdReadsAllowed', outcome: 'rejected', callStatus: 'stopped', reason: 'save_failed',
  }), true, 'a stopped call and rejected save are separate facts');
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'dutyCatProfileId', outcome: 'rejected', callStatus: 'stop_failed', reason: 'call_stop_failed',
  }), true);
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'householdReadsAllowed', outcome: 'unconfirmed', callStatus: 'stopped', reconcile: 'settings.read',
  }), true);
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'personaTone', outcome: 'saved', callStatus: 'unchanged', applies: 'now',
  }), false, 'tone starts with the next call');
  assert.equal(validateCompanionReply({
    kind: 'settings-update', field: 'skin', outcome: 'rejected', callStatus: 'stop_failed', reason: 'save_failed',
  }), false, 'pure visual preferences cannot claim they tried to stop media');
});

test('reset and disable stay bound to this native window and installed companion', () => {
  assert.equal(validateCompanionCommand({ kind: 'view.reset' }), true);
  assert.equal(validateCompanionCommand({ kind: 'companion.disable' }), true);
  for (const selector of ['ownerId', 'instanceId', 'pluginId', 'windowId', 'url']) {
    assert.equal(validateCompanionCommand({ kind: 'view.reset', [selector]: 'renderer-choice' }), false);
    assert.equal(validateCompanionCommand({ kind: 'companion.disable', [selector]: 'renderer-choice' }), false);
  }
  assert.equal(validateCompanionReply({ kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' }), true);
});

test('conversation history accepts only an immutable D0 companion identity snapshot', () => {
  const companionIdentity = {
    v: 1,
    name: '猫猫球',
    partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
    live: {
      catId: 'codex-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null,
    },
    deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: 'claude-fable-5-1' },
  };
  const reply = {
    kind: 'conversation',
    threadTitle: '猫猫球 · 伴随对话',
    messages: [{
      id: 'real-message', role: 'assistant', text: '查到了', name: '砚砚', companionIdentity,
    }],
    hasMore: false,
  };

  assert.equal(validateCompanionReply(reply), true);
  const { companionIdentity: _identity, ...legacyMessage } = reply.messages[0];
  assert.equal(validateCompanionReply({
    ...reply,
    messages: [legacyMessage],
  }), true, 'legacy history remains valid by omitting the optional snapshot');
  assert.equal(validateCompanionReply({
    ...reply,
    messages: [{ ...reply.messages[0], companionIdentity: {
      ...companionIdentity,
      deep: { ...companionIdentity.deep, catId: 'another-cat' },
    } }],
  }), false, 'the saved partner cannot be relabelled as another deep cat');
  assert.equal(validateCompanionReply({
    ...reply,
    messages: [{ ...reply.messages[0], companionIdentity: {
      ...companionIdentity,
      currentDuty: { catId: 'another-cat' },
    } }],
  }), false, 'history snapshots are closed and cannot carry current selection');
});

test('voice preparation and typed input are closed actions without selectable identity or Host', () => {
  assert.equal(validateCompanionCommand({ kind: 'prepare' }), true);
  assert.equal(validateCompanionCommand({ kind: 'audio.connect' }), true);
  assert.equal(validateCompanionCommand({ kind: 'audio.connect', mode: 'receive_only' }), true);
  assert.equal(validateCompanionCommand({ kind: 'audio.connect', mode: 'duplex' }), false,
    'legacy duplex remains the byte-identical command with no mode field');
  assert.equal(validateCompanionCommand({ kind: 'text', text: 'An unfamiliar user sentence', clientMessageId: '863adf11-9fa3-4156-93af-94f7d6022d85' }), true);
  for (const field of ['userId', 'catId', 'threadId', 'callId', 'url', 'token', 'cookie']) {
    assert.equal(validateCompanionCommand({ kind: 'prepare', [field]: 'untrusted' }), false, field);
  }
});
test('a package cannot negotiate its own provider media or data channel', () => {
  assert.equal(validateCompanionCommand({ kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }), false);
  assert.equal(validateCompanionReply({ kind: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }), false);
});

test('wire budgets and media syntax reject malformed or oversized renderer inputs', () => {
  assert.equal(validateCompanionCommand({ kind: 'audio.connect' }), true);
  assert.equal(validateCompanionCommand({ kind: 'audio.connect', sdp: 'v=0\r\nm=audio 9 x 1\r\n' }), false);
  for (const sdp of ['', 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', 'X'.repeat(128001)]) {
    assert.equal(validateCompanionCommand({ kind: 'offer', sdp }), false);
  }
  assert.equal(validateCompanionCommand({ kind: 'text', text: '   ', clientMessageId: '863adf11-9fa3-4156-93af-94f7d6022d85' }), false);
  assert.equal(validateCompanionCommand({ kind: 'screen.frame', selectionId: 'picked', frame: { image: 'https://example.com/image', width: 1, height: 1, frameId: 'one', sourceLabel: 'Window', observedAt: 1 } }), false);
  const cycle: { kind: string; cycle?: unknown } = { kind: 'state' }; cycle.cycle = cycle;
  assert.equal(validateCompanionCommand(cycle), false);
});

test('surface state preserves real actors but never leaks internal handles or raw errors', () => {
  const nativeWork = {
    scopeId: '0123456789abcdef', revision: 7,
    active: [{ taskId: 'tool-item-1', nativeTurnId: 'turn-1', kind: 'tool', startedAt: 100, expiresAt: 300100 }],
    recent: [{ eventId: 'event-1', taskId: 'tool-item-1', kind: 'result', phase: 'result_handed_to_voice',
      occurredAt: 200, expiresAt: 120200, resultId: 'result-1', nativeCarrierCatId: 'codex-sol' }],
  };
  const state = { kind: 'state', phase: 'idle', displayName: 'Companion', skin: 'cat', duty: { catId: 'deep', displayName: 'Deep' },
    carrier: { catId: 'voice', displayName: 'Voice' }, documentsAllowed: true, behaviorEnabled: true,
    toolsReady: false, nativeActivity: 'none',
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    meeting: { kind: 'idle', sharing: false, paused: false, sourceLabel: null }, nativeWork };
  assert.equal(validateCompanionReply(state), true);
  const { meeting: _meeting, ...withoutMeeting } = state;
  assert.equal(validateCompanionReply(withoutMeeting), false,
    'an exact-version state cannot silently erase meeting capture truth');
  for (const meeting of [
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: 'Google Meet' },
    { kind: 'running', sharing: true, paused: true, sourceLabel: null },
    { kind: 'running', sharing: false, paused: true, sourceLabel: 'Teams' },
    { kind: 'stopped', sharing: false, paused: false, sourceLabel: null },
    { kind: 'unconfirmed', sharing: false, paused: false, sourceLabel: null },
    { kind: 'needs_source', sharing: false, paused: false, sourceLabel: null },
  ]) assert.equal(validateCompanionReply({ ...state, meeting }), true, JSON.stringify(meeting));
  for (const meeting of [
    { kind: 'idle', sharing: true, paused: false, sourceLabel: null },
    { kind: 'stopped', sharing: false, paused: true, sourceLabel: null },
    { kind: 'unconfirmed', sharing: false, paused: false, sourceLabel: 'Zoom' },
    { kind: 'needs_source', sharing: false, paused: false, sourceLabel: 'Zoom' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: '   ' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: 'Zoom\nprivate' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: 'Zoom\u2028spoofed line' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: 'Zoom\u202Etxt.exe' },
    { kind: 'running', sharing: false, paused: false, sourceLabel: 'Z'.repeat(161) },
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom', meetingId: 'private-meeting' },
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom', captureThreadId: 'private-thread' },
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom', chunks: 14 },
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom', asrState: 'ready' },
    { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom', healthNote: 'healthy' },
  ]) assert.equal(validateCompanionReply({ ...state, meeting }), false, JSON.stringify(meeting));
  const { behaviorEnabled: _behavior, ...withoutBehavior } = state;
  assert.equal(validateCompanionReply(withoutBehavior), false,
    'native movement and plugin settings cannot guess the persisted autonomous-behavior preference');
  const receiveOnly = { supportedModes: ['duplex', 'receive_only'], activeMode: 'receive_only' };
  assert.equal(validateCompanionReply({ ...state, phase: 'talking', audio: receiveOnly }), true);
  assert.equal(validateCompanionReply({ ...state, audio: { ...receiveOnly, activeMode: null } }), true);
  assert.equal(validateCompanionReply({ ...state, phase: 'talking', audio: {
    ...receiveOnly, activeMode: null,
  } }), false, 'talking cannot claim an unestablished native mode');
  assert.equal(validateCompanionReply({ ...state, audio: receiveOnly }), false,
    'an idle snapshot cannot retain an active native mode');
  assert.equal(validateCompanionReply({ ...state, audio: {
    supportedModes: ['receive_only'], activeMode: 'receive_only',
  } }), false, 'the additive capability cannot remove legacy duplex');
  assert.equal(validateCompanionReply({ ...state, audio: {
    supportedModes: ['duplex'], activeMode: 'receive_only',
  } }), false, 'active mode must be one the Host advertised');
  assert.equal(validateCompanionReply({ ...state, audio: {
    supportedModes: ['duplex', 'duplex'], activeMode: null,
  } }), false, 'capabilities are a set, not an ambiguous preference list');
  assert.equal(validateCompanionReply({ ...state,
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: 'configured-model-is-not-observed' } }), false);
  assert.equal(validateCompanionReply({ ...state, nativeActivity: 'tool_running' }), true);
  assert.equal(validateCompanionReply({ ...state, nativeActivity: 'busy_because_it_feels_like_it' }), false);
  const { nativeActivity: _activity, ...withoutActivity } = state;
  assert.equal(validateCompanionReply(withoutActivity), false);
  const { nativeWork: _work, ...withoutWork } = state;
  assert.equal(validateCompanionReply(withoutWork), false);
  assert.equal(validateCompanionReply({ ...state, nativeWork: { ...nativeWork, scopeId: 'raw-call-id-that-is-not-a-digest' } }), false);
  assert.equal(validateCompanionReply({ ...state, nativeWork: { ...nativeWork,
    recent: [{ ...nativeWork.recent[0], phase: 'voice_was_definitely_heard' }] } }), false);
  assert.equal(validateCompanionReply({ ...state, nativeWork: { scopeId: null, revision: 0,
    active: nativeWork.active, recent: [] } }), false, 'idle scope cannot carry work from another call');
  assert.equal(validateCompanionReply({ ...state, callId: 'private-handle' }), false);
  assert.equal(validateCompanionReply({ kind: 'error', code: 'unavailable' }), true);
  assert.equal(validateCompanionReply({ kind: 'error', code: 'unavailable', message: '/private/secret' }), false);
  assert.equal(validateCompanionEvent({ kind: 'media-stopped', reason: 'locked' }), true);
  assert.equal(validateCompanionEvent({ kind: 'media-stopped', reason: 'resume-capture' }), false);
});

test('passive decision reading has bounded pages and no renderer approval command', () => {
  assert.equal(validateCompanionCommand({ kind: 'decisions.read', offset: 0, limit: 20 }), true);
  assert.equal(validateCompanionCommand({ kind: 'decisions.read', offset: 0, limit: 21 }), false);
  assert.equal(validateCompanionCommand({ kind: 'decisions.read', offset: 0, limit: 20, proposalId: 'other' }), false);
  assert.equal(validateCompanionCommand({ kind: 'decision.approve', proposalId: 'taste-1' }), false);
  assert.equal(validateCompanionCommand({ kind: 'f221.inspect', proposalId: '11111111-1111-4111-8111-111111111111' }), true);
  assert.equal(validateCompanionCommand({ kind: 'f221.inspect', proposalId: 'proposal_mgf2abc12345678' }), true,
    'the host-generated F221 proposal ID must reach the exact preview');
  assert.equal(validateCompanionCommand({ kind: 'f221.inspect', proposalId: '../other-owner' }), false);
  assert.equal(validateCompanionCommand({ kind: 'f221.inspect', proposalId: '11111111-1111-4111-8111-111111111111', digest: 'forged' }), false);
  assert.equal(validateCompanionReply({ kind: 'decision-trial', status: 'trial_confirmed' }), true);
  assert.equal(validateCompanionReply({ kind: 'decision-trial', status: 'approved' }), false);
  const reply = { kind: 'decisions', status: 'available', approvalCount: 1, needsMeCount: 2,
    otherNeedsMeCount: 1, approvals: [{ proposalId: 'taste-1', sourceFeatureId: 'F221',
      summary: '品味提案', resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true }],
    otherNeedsMe: [{ subjectRef: 'task:one', summary: '看看任务' }],
    page: { offset: 0, limit: 20, hasMoreApprovals: false, hasMoreNeedsMe: false } };
  assert.equal(validateCompanionReply(reply), true);
  assert.equal(validateCompanionReply({ ...reply, approvalCount: 0, approvals: reply.approvals, token: 'secret' }), false);
  assert.equal(validateCompanionReply({ ...reply, status: 'unavailable', approvalCount: null,
    needsMeCount: null, otherNeedsMeCount: null, approvals: [], otherNeedsMe: [] }), true);
});

test('unified decision reads preserve partial truth, concrete variants, and Host-bound navigation', () => {
  const source = (status: 'available' | 'unavailable', coverage: 'complete' | 'unknown') => ({ status, coverage });
  const reply = {
    kind: 'decisions', version: 1, status: 'partial', observedAt: 42,
    sources: {
      approvals: source('available', 'complete'),
      needsMe: source('unavailable', 'unknown'),
    },
    items: [
      {
        variantRef: 'variant-a', kind: 'repair', summary: '修复第一处',
        navigation: { targets: ['action', 'origin'] },
      },
      {
        variantRef: 'variant-b', kind: 'repair', summary: '修复冲突版本',
        navigation: { targets: ['origin'] },
      },
    ],
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  } as const;

  assert.equal(validateCompanionReply(reply), true,
    'every retained source variant stays visible under its opaque concrete ref');
  assert.equal(validateCompanionReply({ ...reply, totalCount: 2 }), false,
    'a partial read cannot claim an exact total');
  assert.equal(validateCompanionReply({ ...reply, page: { ...reply.page, limit: 1 } }), false,
    'known_rows cannot exceed the requested public page size');
  assert.equal(validateCompanionReply({ ...reply, items: [], page: { ...reply.page, hasMore: true } }), false,
    'known_rows hasMore cannot skip an otherwise nonempty bounded page');
  assert.equal(validateCompanionReply({ ...reply,
    sources: { ...reply.sources, needsMe: { status: 'unavailable', coverage: 'partial' } } }), false,
  'an unread source cannot claim partial enumeration coverage');
  assert.equal(validateCompanionReply({ ...reply,
    items: [reply.items[0], { ...reply.items[1], variantRef: 'variant-a' }] }), false,
  'renderer keys must distinguish every concrete source variant');
  assert.equal(validateCompanionReply({ ...reply,
    items: [{ ...reply.items[0], navigation: { targets: ['action'], threadId: 'private-thread' } }] }), false,
  'the renderer receives only Host-bound navigation choices, never raw private coordinates');
  const approvalItem = {
    variantRef: 'approval-a', kind: 'approval', summary: '审批事项',
    navigation: { targets: ['approval_card', 'origin'] },
    approval: { resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true },
  } as const;
  assert.equal(validateCompanionReply({ ...reply, items: [approvalItem] }), true);
  assert.equal(validateCompanionReply({ ...reply, items: [{ ...approvalItem,
    approval: { ...approvalItem.approval, proposalId: 'private-proposal', sourceFeatureId: 'F221' } }] }), false,
  'the unified renderer receives lifecycle and safe navigation, not private producer coordinates');
  assert.equal(validateCompanionReply({ ...reply, items: [{ ...approvalItem, decisionRef: 'approval:F221:private' }] }), false,
    'the concrete opaque ref replaces the internal logical producer coordinate at this boundary');

  const complete = {
    ...reply,
    status: 'available',
    sources: {
      approvals: source('available', 'complete'),
      needsMe: source('available', 'complete'),
    },
    totalCount: 2,
  } as const;
  assert.equal(validateCompanionReply(complete), true);
  assert.equal(validateCompanionReply({ ...complete, totalCount: 3 }), false,
    'an exact total also makes known_rows hasMore mechanically checkable');
  assert.equal(validateCompanionReply({ ...complete, items: [], page: { ...complete.page, hasMore: true } }), false,
    'an exact total cannot advertise a nonempty page while withholding its known rows');
  assert.equal(validateCompanionReply({ ...complete,
    sources: { ...complete.sources, needsMe: source('available', 'unknown') } }), false,
  'an exact total requires complete public source coverage');

  assert.equal(validateCompanionCommand({ kind: 'decision.open', variantRef: 'variant-a', target: 'action' }), true);
  assert.equal(validateCompanionCommand({ kind: 'decision.open', variantRef: 'variant-a', target: 'origin', threadId: 'forged' }), false);
  assert.equal(validateCompanionCommand({ kind: 'decision.open', variantRef: '../foreign-variant', target: 'origin' }), false,
    'the Host-issued opaque ref uses a closed grammar and cannot become a path-like selector');
});
