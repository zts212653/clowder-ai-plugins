import assert from 'node:assert/strict';
import test from 'node:test';
import { attempts } from '../web/attempts.mjs';
import { preDeliveryFlow } from '../web/automation-view.mjs';
import { panorama } from '../web/panorama.mjs';
import { workflow } from '../web/workflow.mjs';

const stamp = '2026-10-15T10:00:00Z';
const delivery = {
  id: 'd'.repeat(24),
  mode: 'version',
  source: { tag: 'v2', title: '版本 v2' },
  issues: [],
  commits: [],
  status: 'CODE_PREPARE_REQUIRED',
  base: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) },
  target: 'c'.repeat(40),
  candidate: 'e'.repeat(40),
  startedAt: stamp,
};
function task(id, status, stepStatus) {
  return {
    id,
    action: 'prepare',
    status,
    deliveryId: delivery.id,
    startedAt: stamp,
    steps: [
      {
        id: 'candidate-check',
        key: 'candidate-check',
        label: '检查当前候选',
        stage: 2,
        status: stepStatus,
        startedAt: stamp,
        ...(stepStatus === 'FAILED'
          ? {
              finishedAt: stamp,
              error: {
                code: 'CHECK_FAILED',
                message: '候选检查未完成',
                stderr: 'secret-must-not-render',
              },
            }
          : {}),
      },
    ],
  };
}
function record(tasks = []) {
  return {
    delivery,
    tasks,
    current: true,
    configurations: [],
    issues: [],
    events: [],
    missingTasks: [],
    taskPage: {},
  };
}
const snapshot = {
  config: { mode: 'version' },
  state: { active: delivery, issues: {} },
  platform: {},
};

test('successful observation calls do not claim merge or acceptance while the platform PR is still open', () => {
  const waiting = {
    ...delivery,
    mode: 'continuous',
    issues: [{ sourceId: 'issue-1' }],
    status: 'WAITING_APPROVAL',
    prUrl: 'https://codehub.example/core/pull/1',
  };
  const operation = {
    ...task('1'.repeat(32), 'SUCCEEDED', 'DONE'),
    steps: ['merge-observe', 'merge-verify', 'issue-sync'].map((key, i) => ({
      id: key,
      key,
      stage: i ? 5 : 4,
      status: 'DONE',
      startedAt: stamp,
      deliveryId: waiting.id,
    })),
  };
  const state = { ...snapshot, state: { active: waiting, automation: { autoMerge: true } }, operation };
  const selected = { ...record([operation]), delivery: waiting };
  assert.match(
    attempts(4, selected, operation, false, state),
    /data-step-key="merge-observe"[^>]*data-operation-state="AUTO_WAIT"/,
  );
  for (const key of ['merge-verify', 'issue-state']) {
    assert.match(
      attempts(5, selected, operation, false, state),
      new RegExp(`data-step-key="${key}"[^>]*data-operation-state="PENDING"`),
    );
    assert.match(
      panorama(state, selected, false),
      new RegExp(`data-flow-node="${key}"[^>]*data-flow-node-status="PENDING"`),
    );
  }
});

test('each real substep has one current row with retries folded underneath and the latest state on that row', () => {
  const first = task('1'.repeat(32), 'FAILED', 'FAILED');
  const second = task('2'.repeat(32), 'RUNNING', 'RUNNING');
  const html = attempts(2, record([first]), second, false, snapshot);
  assert.equal((html.match(/data-step-key="candidate-check"/g) ?? []).length, 1);
  assert.equal((html.match(/data-attempt="/g) ?? []).length, 2);
  assert.match(html, /data-step-key="candidate-check"[^>]*data-operation-state="RUNNING"/);
  assert.doesNotMatch(html, /class="attempt-steps"|class="operation-steps"/);
  assert.doesNotMatch(html, /<details data-attempt="[^>]*\sopen[\s>]/);
  assert.doesNotMatch(html, /secret-must-not-render/);
  const done = attempts(2, record([first]), task(second.id, 'SUCCEEDED', 'DONE'), false, snapshot);
  assert.match(done, /data-step-key="candidate-check"[^>]*data-operation-state="DONE"/);
});

test('unstarted stages retain their plan, while missing historical evidence is explicit and remains read-only', () => {
  const future = attempts(3, record(), null, false, snapshot);
  assert.match(future, /data-step-key="candidate-publish"[^>]*data-operation-state="PENDING"/);
  assert.match(future, /计划/);
  const historical = attempts(
    3,
    { ...record(), current: false },
    task('9'.repeat(32), 'RUNNING', 'RUNNING'),
    true,
    snapshot,
  );
  assert.match(historical, /执行证据未记录/);
  assert.doesNotMatch(historical, /data-action=|data-operation-state="RUNNING"/);
});

test('workflow uses the same substep list for rendering and incremental updates, with safe errors at the failed step', () => {
  const failed = task('1'.repeat(32), 'FAILED', 'FAILED');
  const html = workflow({ ...snapshot, operation: failed }, record([failed]), false);
  assert.equal((html.match(/data-attempts-stage="/g) ?? []).length, 5);
  assert.equal((html.match(/data-step-key="candidate-check"/g) ?? []).length, 1);
  assert.equal((html.match(/class="substeps"/g) ?? []).length, 5);
  assert.match(html, /data-stage="2" data-stage-state="failed"/);
  assert.match(html, /data-stage-detail>异常 · CHECK_FAILED · 展开查看处理建议/);
  assert.match(html, /error-guide/);
  assert.doesNotMatch(html, /secret-must-not-render|class="attempt-steps"/);
  assert.doesNotMatch(
    workflow({ ...snapshot, operation: failed }, { ...record([failed]), current: false }, true),
    /data-action=/,
  );
});

test('pre-delivery failures and pauses have one recovery action in the same five-stage flow', () => {
  for (const status of ['FAILED', 'PAUSED']) {
    const current = {
      config: { mode: 'continuous' },
      state: { automation: { status } },
      operation: {
        id: '8'.repeat(32),
        action: 'synchronize',
        status: 'FAILED',
        startedAt: stamp,
        error: { code: 'SOURCE_UNPROVEN', message: '来源尚未读取完整' },
        steps: [
          {
            id: 'github-deliveries',
            key: 'github-deliveries',
            label: '读取来源集合',
            stage: 1,
            status: 'FAILED',
            startedAt: stamp,
            error: { code: 'SOURCE_UNPROVEN', message: '来源尚未读取完整' },
          },
        ],
      },
    };
    const html = preDeliveryFlow(current);
    assert.equal((html.match(/data-action="resume-sync"/g) ?? []).length, 1);
    assert.equal((html.match(/data-attempts-stage="/g) ?? []).length, 5);
    assert.match(html, /data-step-key="github-deliveries"[^>]*data-operation-state="FAILED"/);
    assert.match(html, /data-step-key="candidate-build"[^>]*data-operation-state="PENDING"/);
    assert.match(html, /error-guide/);
  }
});

test('pre-delivery flow accepts the shared action policy so audit repair never offers a fresh synchronization', () => {
  const html = preDeliveryFlow(
    {
      config: { mode: 'version' },
      state: { automation: { status: 'FAILED' } },
      operation: {
        id: '7'.repeat(32),
        action: 'synchronize',
        status: 'SUCCEEDED',
        steps: [],
        persistence: {
          status: 'FAILED',
          error: { code: 'TASK_STORE_FAILED', message: '执行记录未保存' },
        },
      },
    },
    {
      stage: 5,
      special: 'persist-operation',
      label: '只补存原任务记录',
      text: '只修记录，不重跑业务。',
    },
  );
  assert.equal((html.match(/data-persist-operation/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-action="resume-sync"|data-action="synchronize"/);
  assert.match(html, /data-step-key="execution-record"[^>]*data-operation-state="FAILED"/);
});

test('live admission keeps showing scoped substeps before the next status read supplies the delivery', () => {
  const operation = task('6'.repeat(32), 'RUNNING', 'RUNNING');
  operation.steps[0].deliveryId = delivery.id;
  const html = attempts(2, null, operation, false, {
    config: { mode: 'version' },
    state: {},
  });
  assert.match(html, /data-step-key="candidate-check"[^>]*data-operation-state="RUNNING"/);
  assert.equal((html.match(/id="operation"/g) ?? []).length, 1);
  const foreign = {
    ...record([operation]),
    delivery: { ...delivery, id: 'f'.repeat(24) },
  };
  const isolated = attempts(2, foreign, operation, false, snapshot);
  assert.doesNotMatch(isolated, /data-operation-state="RUNNING"|data-attempt="/);
});

test('pre-delivery stage completion requires a nonempty set of actual steps that are all done', () => {
  const html = preDeliveryFlow({
    config: { mode: 'continuous' },
    state: { automation: { status: 'RUNNING' } },
    operation: {
      id: '5'.repeat(32),
      action: 'synchronize',
      status: 'RUNNING',
      steps: [
        {
          id: 'target-check',
          key: 'target-check',
          label: '核验来源',
          stage: 1,
          status: 'DONE',
          startedAt: stamp,
          finishedAt: stamp,
        },
        {
          id: 'candidate-build',
          key: 'candidate-build',
          label: '准备候选',
          stage: 2,
          status: 'RUNNING',
          startedAt: stamp,
        },
      ],
    },
  });
  assert.match(html, /data-stage="1" data-stage-state="done"[^>]*><summary><span class="stage-mark good">✓/);
  assert.match(html, /data-stage="2" data-stage-state="current"/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(html, /data-stage-detail>正在：准备提交映射并保留内部文件/);
  assert.match(html, /data-stage="3" data-stage-state="pending"/);
  assert.doesNotMatch(html, /data-stage="[345]" data-stage-state="done"/);
});
