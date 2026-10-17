import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentBubble } from '../src/recent-bubble.mjs';

test('a voice caption updates the two-line glance without turning a caption into saved history', () => {
  const rows = [{}, {}];
  const bubble = new RecentBubble(rows);
  bubble.load([
    { id: 'old', role: 'user', name: '你', text: '昨天的讨论' },
    { id: 'new', role: 'assistant', name: '宪宪', text: '我记得那段' },
  ]);
  assert.deepEqual(rows.map(row => row.textContent), ['你：昨天的讨论', '宪宪：我记得那段']);
  bubble.append('user', '我想', '语音'); bubble.append('user', '补充', '语音');
  assert.deepEqual(rows.map(row => row.textContent), ['宪宪：我记得那段', '语音：我想补充']);
  bubble.finish('user');
  assert.deepEqual(rows.map(row => row.textContent), ['你：昨天的讨论', '宪宪：我记得那段']);
  assert.equal(bubble.hasContent(), true);
});

test('the glance clips long content and clears when there is no conversation', () => {
  const rows = [{}, {}];
  const bubble = new RecentBubble(rows);
  bubble.load([{ id: 'long', role: 'assistant', name: '猫', text: '长'.repeat(400) }]);
  assert.equal(rows[1].hidden, true);
  assert.ok(rows[0].textContent.length < 150);
  bubble.load([]);
  assert.equal(bubble.hasContent(), false);
  assert.ok(rows.every(row => row.hidden));
});

test('call glances preserve only source identity needed to observe their rendered row', () => {
  const rows = [{}, {}];
  const bubble = new RecentBubble(rows);
  bubble.loadTranscript([{
    messageId: 'message-1', role: 'assistant', text: 'durable answer', source: { kind: 'voice' },
  }], '宪宪');
  assert.deepEqual(
    bubble.rowsForReference({ kind: 'message', messageId: 'message-1' }),
    [rows[0]],
  );

  const live = bubble.append('assistant', 'live answer', '宪宪', {
    kind: 'native-item', nativeItemId: 'output-item-1',
  });
  assert.equal(live.textContent, '宪宪：live answer');
  assert.deepEqual(
    bubble.rowsForReference({ kind: 'native-item', nativeItemId: 'output-item-1' }),
    [live],
  );
  assert.equal(JSON.stringify(rows).includes('output-item-1'), false,
    'correlation metadata does not become public DOM content');
});

test('a call speech bubble can suppress synthetic speaker chrome without losing its source reference', () => {
  const rows = [{}, {}];
  const bubble = new RecentBubble(rows, { showSpeaker: false });
  const live = bubble.append('assistant', 'synthetic remote voice', '隔离S7合成通话', {
    kind: 'native-item', nativeItemId: 'output-item-2',
  });

  assert.equal(live.textContent, 'synthetic remote voice');
  assert.deepEqual(bubble.rowsForReference({ kind: 'native-item', nativeItemId: 'output-item-2' }), [live]);
});
