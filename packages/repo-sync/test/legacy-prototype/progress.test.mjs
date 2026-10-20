import assert from 'node:assert/strict';
import test from 'node:test';
import { renderObjects } from './render-detail.mjs';
import { renderOverview } from './render-overview.mjs';
import { createState, reduce } from './state.mjs';

test('preparation displays its five child steps directly before the optional technical details', () => {
  const state = reduce(createState('behind'), { type: 'start' });
  const html = renderOverview(state, 1);
  for (let step = 1; step <= 5; step++) assert.ok(html.includes(`data-step="${step}"`));
  assert.ok(html.indexOf('data-step="1"') < html.indexOf('id="technical-details"'));
  assert.ok(html.includes('data-step-status="current"'));
  assert.doesNotMatch(html, /（1\/5）/);
});

test('each failed operation displays a cross and its corresponding error information', () => {
  for (const [scenario, phase, code] of [
    ['drift', 1, 'CORE_BASELINE_MISMATCH'],
    ['timeout', 4, 'PR_CREATE_TIMEOUT'],
    ['plugin', 5, 'PLUGIN_INCOMPATIBLE'],
    ['metadata', 8, 'ISSUE_CLOSE_FAILED'],
  ]) {
    const html = renderOverview(createState(scenario), phase);
    assert.ok(html.includes(`data-step-error="${phase}"`), scenario);
    assert.ok(html.includes('data-step-status="failed"'), scenario);
    assert.ok(html.includes('×'), scenario);
    assert.ok(html.includes(code), scenario);
  }
});

test('Issue creation completes during preparation, and reconciliation reuses that mapped object', () => {
  let state = reduce(createState('behind'), { type: 'start' });
  state = reduce(reduce(state, { type: 'advance' }), { type: 'advance' });
  const issue = state.active.internalIssue;
  assert.equal(state.active.issueStatus, 'open');
  assert.ok(issue);
  for (let step = 0; step < 3; step++) state = reduce(state, { type: 'advance' });
  state = reduce(reduce(state, { type: 'approve' }), { type: 'advance' });
  assert.equal(state.active.internalIssue, issue);
  state = reduce(state, { type: 'advance' });
  assert.equal(state.active.internalIssue, issue);
  assert.equal(state.active.issueResult, 'already-closed');
});

test('an already closed Issue is confirmed without another close operation', () => {
  const state = reduce(createState('reconcile'), { type: 'advance' });
  assert.equal(state.active.issueStatus, 'closed');
  assert.equal(state.active.issueResult, 'already-closed');
});

test('an open Issue with a closing obligation is closed after merge and verification', () => {
  let state = createState('waiting');
  state.active.autoCloseIssue = false;
  state = reduce(state, { type: 'approve' });
  assert.equal(state.active.issueStatus, 'open');
  state = reduce(reduce(state, { type: 'advance' }), { type: 'advance' });
  assert.equal(state.active.issueStatus, 'closed');
  assert.equal(state.active.issueResult, 'closed-by-sync');
});

test('a related Issue keeps its existing state and its historical result after the next sync starts', () => {
  let state = createState('waiting');
  state.active.issueRelation = 'related';
  state = reduce(reduce(reduce(state, { type: 'approve' }), { type: 'advance' }), { type: 'advance' });
  assert.equal(state.active.issueStatus, 'open');
  assert.equal(state.active.issueResult, 'left-unchanged');
  assert.ok(renderObjects(state, state.deliveries[0]).includes('普通关联'));
  state = reduce(state, { type: 'start' });
  assert.ok(renderObjects(state, state.deliveries[0]).includes('普通关联'));
});

test('error details are displayed as escaped text', () => {
  const state = createState('plugin');
  state.active.error = { code: 'SENTINEL', message: '<img src=x onerror=alert(1)>' };
  const html = renderOverview(state, 5);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('an incorrect internal Issue mapping blocks reconciliation without closing anything', () => {
  const state = createState('manual-close');
  state.active.internalIssue = 999;
  const next = reduce(state, { type: 'advance' });
  assert.equal(next.active.phase, 8);
  assert.equal(next.active.block, 'metadata');
  assert.equal(next.active.issueStatus, 'open');
  assert.ok(renderOverview(next, 8).includes('ISSUE_MAPPING_UNVERIFIED'));
  assert.ok(renderOverview(next, 8).includes('关单已暂停'));
  assert.ok(renderObjects(next, next.deliveries[0]).includes('关单已暂停'));
});

test('a previously closed related Issue is preserved through PR merge and reconciliation', () => {
  let state = createState('waiting');
  state.active.issueRelation = 'related';
  state.active.issueStatus = 'closed';
  state = reduce(reduce(reduce(state, { type: 'approve' }), { type: 'advance' }), { type: 'advance' });
  assert.equal(state.active.issueStatus, 'closed');
  assert.equal(state.active.issueResult, 'left-unchanged');
});
