import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCompanionCommand, validateCompanionReply, validateCompanionEvent } from './companion-bridge.js';

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
    carrier: { catId: 'voice', displayName: 'Voice' }, documentsAllowed: true, toolsReady: false };
  assert.equal(validateCompanionReply(state), true);
  assert.equal(validateCompanionReply({ ...state, callId: 'private-handle' }), false);
  assert.equal(validateCompanionReply({ kind: 'error', code: 'unavailable' }), true);
  assert.equal(validateCompanionReply({ kind: 'error', code: 'unavailable', message: '/private/secret' }), false);
  assert.equal(validateCompanionEvent({ kind: 'media-stopped', reason: 'locked' }), true);
  assert.equal(validateCompanionEvent({ kind: 'media-stopped', reason: 'resume-capture' }), false);
});
