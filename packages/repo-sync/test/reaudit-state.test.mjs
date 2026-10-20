import assert from 'node:assert/strict';
import test from 'node:test';
import { stageGroups } from '../web/attempts.mjs';
import { preDeliveryPresentation, stagePresentation } from '../web/flow-stage.mjs';
import { panorama } from '../web/panorama.mjs';
import { recoveryDisposition } from '../web/recovery-navigation.mjs';
import { projectStep } from '../web/step-plan.mjs';
import { retainView } from '../web/view-state.mjs';

const d = {
  id: 'd'.repeat(24),
  mode: 'version',
  status: 'CANCELLED',
  prUrl: 'https://codehub.example/team/core/pull/1',
  candidate: 'b'.repeat(40),
  checks: { passed: true },
  cancellation: { status: 'COMPLETE' },
  issues: [],
  target: 'a'.repeat(40),
  base: { upstream: 'c'.repeat(40), internal: 'e'.repeat(40) },
  source: { tag: 'v2' },
};
const task = {
  id: 'cancel',
  action: 'cancel-delivery',
  deliveryId: d.id,
  status: 'SUCCEEDED',
  steps: [
    {
      id: 'cancel-pr',
      key: 'cancel-pr',
      stage: 4,
      status: 'DONE',
      deliveryId: d.id,
      startedAt: '2026-10-17T00:00:00Z',
    },
  ],
};

test('closing a PR cannot prove a merge in current, historical or no-active-delivery presentations', () => {
  assert.notEqual(stagePresentation(4, d, 2).state, 'done');
  assert.notEqual(stagePresentation(5, d, 2).state, 'done');
  assert.notEqual(preDeliveryPresentation(4, task, { stage: 1, outcome: 'cancelled' }).state, 'done');
  const snapshot = {
    config: { mode: 'version' },
    operation: task,
    state: { active: null, automation: { status: 'PAUSED', restartOf: d.id } },
  };
  for (const [record, historical] of [
    [null, false],
    [{ delivery: d, tasks: [task] }, true],
  ]) {
    const html = panorama(snapshot, record, historical);
    assert.doesNotMatch(html, /data-flow-stage="4" data-flow-state="done"/);
    const groups = stageGroups(4, record, task, historical, snapshot);
    assert.notEqual(projectStep(groups.get('merge-observe')).status, 'DONE');
    assert.notEqual(projectStep(groups.get('platform-review')).status, 'WAITING');
  }
});
test('only an actual merge observation or accepted internal SHA makes review complete', () => {
  for (const patch of [
    {},
    { prCreation: { status: 'RESULT_UNKNOWN' } },
    { autoMerge: { status: 'WAITING', reason: 'CI pending' } },
  ])
    assert.notEqual(
      stagePresentation(4, { ...d, cancellation: undefined, status: 'WAITING_APPROVAL', ...patch }, 4).state,
      'done',
    );
  for (const patch of [
    { mergeObservation: { source: 'platform', head: d.candidate } },
    { acceptedInternal: d.candidate },
  ])
    assert.equal(
      stagePresentation(4, { ...d, status: 'CODE_ACCEPTED_PENDING_METADATA', ...patch }, 5).state,
      'done',
    );
});
function consent({ pr = 'original-pr', baseline = 'candidate-1', checked = false } = {}) {
  const values = { deliveryId: d.id, previousUrl: pr };
  return {
    name: 'confirmed',
    type: 'checkbox',
    required: true,
    checked,
    value: 'on',
    dataset: {},
    form: {
      dataset: { form: 'cancel-delivery', editBaseline: baseline },
      elements: { namedItem: (key) => (values[key] ? { value: values[key] } : null) },
    },
  };
}
test('unsubmitted action consent survives only same-object redraws and is not transferred to a changed PR or candidate', () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  try {
    globalThis.document = { activeElement: null };
    globalThis.window = { scrollY: 0, scrollTo() {} };
    for (const scope of [{}, { pr: 'replacement-pr' }, { baseline: 'candidate-2' }]) {
      let fields = [consent({ checked: true })];
      const content = {
        dataset: { binding: 'binding', revision: '' },
        contains: () => false,
        querySelectorAll: () => fields,
      };
      const restore = retainView(content, 'binding', undefined);
      fields = [consent(scope)];
      restore();
      assert.equal(fields[0].checked, !Object.keys(scope).length);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('repair context retires only for its own completed or cancelled run', () => {
  const pending = { bindingId: 'binding', runId: 'run', deliveryId: d.id };
  const snapshot = {
    config: { bindingId: 'binding' },
    state: { active: null, automation: { id: 'run', status: 'COMPLETE' } },
  };
  assert.equal(recoveryDisposition(pending, snapshot), 'completed');
  snapshot.state.automation = { id: 'run', status: 'PAUSED', pauseRequested: { afterDeliveryId: d.id } };
  assert.equal(recoveryDisposition(pending, snapshot), 'completed');
  snapshot.state.automation = { id: 'run', status: 'PAUSED', restartOf: d.id };
  assert.equal(recoveryDisposition(pending, snapshot), 'cancelled');
  for (const patch of [
    { id: 'another', status: 'COMPLETE' },
    { id: 'run', status: 'PAUSED', restartOf: 'another' },
  ]) {
    snapshot.state.automation = patch;
    assert.equal(recoveryDisposition(pending, snapshot), null);
  }
  snapshot.state.automation = { id: 'run', status: 'COMPLETE' };
  snapshot.config.bindingId = 'other';
  assert.equal(recoveryDisposition(pending, snapshot), null);
});
