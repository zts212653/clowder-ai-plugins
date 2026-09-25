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

test('voice preparation and typed input are closed actions without selectable identity or Host', () => {
  assert.equal(validateCompanionCommand({ kind: 'prepare' }), true);
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
  const state = { kind: 'state', phase: 'idle', displayName: 'Companion', skin: 'cat', duty: { catId: 'deep', displayName: 'Deep' },
    carrier: { catId: 'voice', displayName: 'Voice' }, documentsAllowed: true, toolsReady: false, nativeActivity: 'none' };
  assert.equal(validateCompanionReply(state), true);
  assert.equal(validateCompanionReply({ ...state, nativeActivity: 'tool_running' }), true);
  assert.equal(validateCompanionReply({ ...state, nativeActivity: 'busy_because_it_feels_like_it' }), false);
  const { nativeActivity: _activity, ...withoutActivity } = state;
  assert.equal(validateCompanionReply(withoutActivity), false);
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
