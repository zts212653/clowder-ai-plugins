import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDelivery } from './render-delivery.mjs';
import { renderOverview } from './render-overview.mjs';
import { createState, reduce } from './state.mjs';

test('each state presents its next action before optional technical details', () => {
  for (const scenario of [
    'unconfigured',
    'behind',
    'waiting',
    'verify',
    'reconcile',
    'timeout',
    'plugin',
    'drift',
    'metadata',
    'synced',
  ]) {
    const html = renderOverview(createState(scenario), 1);
    assert.ok(html.includes('id="current-task"'), `missing task in ${scenario}`);
    assert.equal((html.match(/class="button primary"/g) ?? []).length, 1, `competing actions in ${scenario}`);
    if (html.includes('id="technical-details"'))
      assert.ok(html.indexOf('id="current-task"') < html.indexOf('id="technical-details"'));
  }
});
test('the nine-step explanation is collapsed and separated from the actual next action', () => {
  const html = renderOverview(createState('waiting'), 7);
  assert.match(html, /<details id="technical-details"[^>]*>/);
  assert.doesNotMatch(html, /<details id="technical-details"[^>]* open/);
  assert.match(html, /打开内部 PR #92/);
  assert.doesNotMatch(html, /id="auto-step"/);
});
test('the current task tells the user who handles verification and how the demo continues', () => {
  const html = renderOverview(createState('verify'), 1);
  assert.match(html, /系统.*核验|系统.*检查/);
  assert.match(html, /id="auto-step"/);
  assert.match(html, /继续演示/);
});
test('a historical delivery offers a way back to the current task, without advancing another PR', () => {
  let state = createState('waiting');
  state = reduce(state, { type: 'approve' });
  state = reduce(state, { type: 'advance' });
  state = reduce(state, { type: 'advance' });
  state = reduce(state, { type: 'start' });
  const html = renderDelivery(state, 'delivery-041', 9);
  assert.match(html, /id="current-task"/);
  assert.match(html, /返回.*同步|返回.*工作台/);
  assert.doesNotMatch(html, /id="advance"|id="auto-step"/);
});
