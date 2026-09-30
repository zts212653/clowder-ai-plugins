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
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null }, nativeWork };
  assert.equal(validateCompanionReply(state), true);
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
