import assert from 'node:assert/strict';
import test from 'node:test';
import { phaseLocation } from '../src/recording.mjs';
import { taskInput } from '../src/task-store.mjs';
import { attempts } from '../web/attempts.mjs';
import { automaticPolicy, automationBanner } from '../web/automation-view.mjs';
import { preDeliveryFlow } from '../web/automation-view.mjs';
import { workflow } from '../web/workflow.mjs';
import { sourceTargetForm } from '../web/source-target.mjs';
import { continuationControls } from '../web/continuation-view.mjs';
import { esc, sha } from '../web/ui.mjs';
import { projectStep } from '../web/step-plan.mjs';
import { nextAction } from '../web/action-policy.mjs';

const time = '2026-10-15T10:00:00Z';
const delivery = {
  id: 'd'.repeat(24),
  mode: 'continuous',
  source: { number: 1, title: 'One' },
  status: 'WAITING_APPROVAL',
  prUrl: 'https://codehub.example/core/pull/1',
  candidate: 'c'.repeat(40),
  base: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) },
  target: 'c'.repeat(40),
  issues: [{ number: 71 }],
  commits: [],
};
const snapshot = {
  config: { mode: 'continuous' },
  state: {
    active: delivery,
    issues: {},
    queue: [],
    templates: { title: 'Sync', body: 'Source' },
    automation: { id: 'a'.repeat(32), status: 'WAITING_REVIEW', startedAt: time },
  },
};
const record = { delivery, tasks: [], configurations: [], events: [], issues: [], missingTasks: [], taskPage: {} };
const keys = (html) => [...html.matchAll(/data-step-key="([^"]+)"/g)].map((item) => item[1]);
function task(steps) {
  return {
    id: 'b'.repeat(32),
    action: 'resume-sync',
    status: 'RUNNING',
    deliveryId: delivery.id,
    startedAt: time,
    steps,
  };
}
function step(key, extra = {}) {
  return { id: key, key, label: key, stage: 2, status: 'RUNNING', startedAt: time, ...extra };
}

test('a fixed business plan exists before execution, and low-level phases only add evidence', () => {
  const before = attempts(2, record, null, false, snapshot);
  const operation = task([
    step('delivery-prepare'),
    step('candidate-build', { status: 'DONE' }),
    step('source-fetch', { parentId: 'delivery-prepare' }),
    step('ledger-save', { status: 'DONE' }),
  ]);
  const after = attempts(2, record, operation, false, snapshot);
  assert.deepEqual(keys(after), keys(before));
  assert.match(after, /data-attempt="[^" ]+:source-fetch"/);
});
test('multiple Issue objects stay inside one predeclared business step', () => {
  const before = attempts(2, record, null, false, snapshot);
  const operation = task([
    step('issue-create', { label: '创建 Issue #71', status: 'DONE' }),
    step('issue-create', { id: 'second', label: '创建 Issue #72' }),
  ]);
  const after = attempts(2, record, operation, false, snapshot);
  assert.deepEqual(keys(after), keys(before));
  assert.match(after, /data-step-key="issue-create"[^>]*data-operation-state="RUNNING"/);
  assert.match(after, /Issue #71/);
  assert.match(after, /Issue #72/);
});
test('recovery business phase and all its children belong to post-merge verification', () => {
  const parent = { ...phaseLocation('resume-sync', 'delivery-verify'), key: 'delivery-verify' };
  assert.equal(parent.stage, 5);
  for (const key of ['source-fetch', 'internal-fetch', 'candidate-ref', 'issue-link', 'ledger-save'])
    assert.equal(phaseLocation('resume-sync', key, parent).stage, 5, key);
});
test('post-merge running policy drives the visible current stage instead of the stale delivery status', () => {
  const operation = task([step('merge-verify', { stage: 5 })]);
  const html = workflow({ ...snapshot, operation }, record, false);
  assert.match(html, /data-stage="5" data-stage-state="current"/);
  assert.doesNotMatch(html, /data-stage="2" data-stage-state="current"/);
});
test('failed candidate checks stay in preparation even when a candidate SHA already exists', () => {
  const failed = {
    ...snapshot,
    state: {
      ...snapshot.state,
      active: { ...delivery, status: 'CODE_PREPARE_REQUIRED', prUrl: undefined },
      automation: { ...snapshot.state.automation, status: 'FAILED' },
    },
    operation: {
      ...task([step('candidate-check', { status: 'FAILED', error: { code: 'CHECK_FAILED' } })]),
      status: 'FAILED',
      error: { code: 'CHECK_FAILED' },
    },
  };
  assert.equal(nextAction(failed, failed.state.active).stage, 2);
});
test('paused between deliveries stays at completed verification and has an explicit next-delivery action', () => {
  const paused = {
    ...snapshot,
    state: {
      ...snapshot.state,
      active: null,
      queue: [{ target: 'next' }],
      automation: {
        ...snapshot.state.automation,
        status: 'PAUSED',
        continuation: 'after-each',
        pauseRequested: { afterDeliveryId: delivery.id, requestedAt: time },
      },
    },
  };
  const policy = automaticPolicy(paused, null);
  assert.equal(policy.stage, 5);
  assert.equal(policy.action, 'resume-sync');
  assert.match(policy.label, /继续下一笔/);
  assert.doesNotMatch(automationBanner(paused), /name="continuation"/);
  const flow = preDeliveryFlow(paused, policy);
  assert.match(flow, /name="continuation"/);
  assert.match(flow, /data-action="resume-sync"/);
  assert.match(sourceTargetForm(snapshot.state, [], esc, sha), /name="continuation"/);
});
test('completed or missing rounds explain why continuation controls are unavailable', () => {
  assert.match(continuationControls({ state: {} }), /没有进行中的同步轮次/);
  assert.match(continuationControls({ state: { automation: { status: 'COMPLETE' } } }), /本轮同步已完成/);
});
test('task admission accepts and validates the restricted continuation controls', () => {
  const base = { action: 'configure-continuation', runId: 'a'.repeat(32), requestId: 'b'.repeat(32) };
  assert.doesNotThrow(() => taskInput({ ...base, continuation: 'after-each' }));
  assert.throws(() => taskInput({ ...base, continuation: 'arbitrary' }), { code: 'INVALID_TASK_INPUT' });
  assert.doesNotThrow(() => taskInput({ ...base, action: 'resume-sync', observeOnly: true }));
  assert.throws(() => taskInput({ ...base, action: 'resume-sync', observeOnly: 'yes' }), {
    code: 'INVALID_TASK_INPUT',
  });
});
test('successful outer tasks cannot hide an unresolved child failure, but a proven retry can clear it', () => {
  const operation = { id: 'b'.repeat(32), status: 'SUCCEEDED' };
  const entries = [
    step('candidate-check', { status: 'DONE' }),
    step('unknown-child', { status: 'FAILED', error: { code: 'UNKNOWN_CHILD' } }),
  ].map((step) => ({ task: operation, step }));
  const group = { key: 'candidate-check', status: 'PENDING', entries };
  assert.equal(projectStep(group).status, 'FAILED');
  entries.push({ task: operation, step: step('unknown-child', { status: 'DONE' }) });
  assert.equal(projectStep(group).status, 'DONE');
});
test('a pause before the first delivery does not claim a previous delivery was accepted', () => {
  const paused = {
    ...snapshot,
    state: {
      ...snapshot.state,
      active: null,
      deliveries: [],
      automation: {
        ...snapshot.state.automation,
        status: 'PAUSED',
        continuation: 'after-each',
        pauseRequested: { afterDeliveryId: null, requestedAt: time },
      },
    },
  };
  assert.equal(automaticPolicy(paused, null).stage, 1);
  assert.doesNotMatch(automationBanner(paused), /上一笔接收已结束|本笔核验、Issue 和接收记录已完成/);
});
