import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAudit } from './audit.mjs';
import { renderOverview } from './render-overview.mjs';
import { createState, reduce } from './state.mjs';

test('the workflow exposes the internal candidate branch and PR title', () => {
  const html = renderOverview(createState('waiting'), 6);
  assert.match(html, /sync\/delivery-041/);
  assert.match(html, /\[上游同步\] PR #84/);
});
test('post-merge verification has its own reachable scenario and keeps the accepted cursor until verified', () => {
  const state = createState('verify');
  assert.equal(state.active?.phase, 7);
  assert.notEqual(state.accepted, state.active.target);
  const verified = reduce(state, { type: 'advance' });
  assert.equal(verified.active.phase, 8);
  assert.equal(verified.accepted, verified.active.target);
  assert.equal(reduce(verified, { type: 'advance' }).active.phase, 9);
});
test('the simulation continuation is inside the current operation context', () => {
  const state = reduce(createState('waiting'), { type: 'approve', note: '审核备注' });
  assert.match(renderOverview(state, 7), /id="current-task"[\s\S]*id="auto-step"/);
});
test('delivery audit does not include another delivery or repository-wide events', () => {
  const state = createState('behind');
  state.events = [
    { label: '本次', deliveryId: 'delivery-041', note: 'sentinel-first' },
    { label: '另一笔', deliveryId: 'delivery-042', note: 'sentinel-second' },
    { label: '仓库配置', note: 'sentinel-repository' },
  ];
  const html = renderAudit(state, 'delivery-041');
  assert.match(html, /sentinel-first/);
  assert.doesNotMatch(html, /sentinel-second|sentinel-repository/);
});
test('discovering new upstream work records it against the new delivery, while leaving the active delivery frozen', () => {
  const state = createState('waiting');
  const next = reduce(state, { type: 'external' });
  assert.equal(next.events.at(-1).deliveryId, next.deliveries.at(-1).id);
  assert.equal(next.active.target, state.active.target);
});
test('legacy discovery records with no source identity are retained but not attributed to a PR', () => {
  const state = createState('behind');
  state.events = [{ deliveryId: 'delivery-041', label: '外部新交付加入队列', note: '当前交付目标保持冻结' }];
  const html = renderAudit(state, 'delivery-041');
  assert.doesNotMatch(html, /外部新交付加入队列/);
  assert.match(html, /归属待核对/);
  assert.equal(state.events.length, 1);
});
