import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeetingStatus, meetingPresentation } from '../src/meeting-state.mjs';

test('meeting presentation distinguishes call sharing from background recording without inferring speech', () => {
  assert.deepEqual(meetingPresentation({
    kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom',
    chunks: 14, asrState: 'ready', signal: 'nonzero_pcm',
  }), { label: '听会中', sourceLabel: 'Zoom', tone: 'active' });
  assert.deepEqual(meetingPresentation({
    kind: 'running', sharing: false, paused: false, sourceLabel: 'Teams',
    chunks: 14, asrState: 'ready', signal: 'nonzero_pcm',
  }), { label: '会议记录中 · 未接入通话', sourceLabel: 'Teams', tone: 'active' });
  assert.deepEqual(meetingPresentation({
    kind: 'running', sharing: true, paused: true, sourceLabel: 'Google Meet',
  }), { label: '会议记录已暂停', sourceLabel: 'Google Meet', tone: 'quiet' });
  assert.deepEqual(meetingPresentation({
    kind: 'running', sharing: false, paused: false, sourceLabel: null,
  }), { label: '会议记录中 · 未接入通话', sourceLabel: null, tone: 'active' });
});

test('uncertain and terminal meeting states use explicit, non-actionable copy', () => {
  assert.equal(meetingPresentation({ kind: 'idle', sharing: false, paused: false, sourceLabel: null }), null);
  assert.deepEqual(meetingPresentation({ kind: 'stopped', sharing: false, paused: false, sourceLabel: null }),
    { label: '会议记录已停止', sourceLabel: null, tone: 'quiet' });
  assert.deepEqual(meetingPresentation({ kind: 'unconfirmed', sharing: false, paused: false, sourceLabel: null }),
    { label: '会议记录状态未确认', sourceLabel: null, tone: 'warning' });
  assert.deepEqual(meetingPresentation({ kind: 'needs_source', sharing: false, paused: false, sourceLabel: null }),
    { label: '需要确认会议所在的 App', sourceLabel: null, tone: 'warning' });
});

test('stopped is a one-shot ten-second confirmation and idle retires it immediately', () => {
  let now = 1_000;
  const status = new MeetingStatus({ now: () => now });
  const running = { kind: 'running', sharing: true, paused: false, sourceLabel: 'Zoom' };
  const stopped = { kind: 'stopped', sharing: false, paused: false, sourceLabel: null };
  const idle = { kind: 'idle', sharing: false, paused: false, sourceLabel: null };

  assert.equal(new MeetingStatus({ now: () => now }).update(stopped), null,
    'a renderer opened onto stale stopped truth must not invent a fresh confirmation');
  assert.equal(status.update(running).label, '听会中');
  assert.equal(status.update(stopped).label, '会议记录已停止');
  now += 9_999;
  assert.equal(status.update(stopped).label, '会议记录已停止');
  now += 1;
  assert.equal(status.update(stopped), null);
  now += 100;
  assert.equal(status.update(stopped), null, 'the same stopped episode stays consumed');

  assert.equal(status.update(running).label, '听会中');
  assert.equal(status.update(stopped).label, '会议记录已停止');
  assert.equal(status.update(idle), null, 'Host idle wins before the timeout');
  assert.equal(status.update(stopped), null, 'idle followed by stale stopped is not a new stop');
});
