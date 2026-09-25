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
  bubble.append('user', '我想'); bubble.append('user', '补充');
  assert.deepEqual(rows.map(row => row.textContent), ['宪宪：我记得那段', '你：我想补充']);
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
