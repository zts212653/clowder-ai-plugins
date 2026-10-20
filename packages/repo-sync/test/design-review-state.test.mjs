import assert from 'node:assert/strict';
import test from 'node:test';
import { actionBar } from '../web/actionbar.mjs';
import { attempts } from '../web/attempts.mjs';
import { restoreExpansion } from '../web/expansion.mjs';
import { setupConfiguration } from '../web/setup-view.mjs';
import { button, esc, sha } from '../web/ui.mjs';

const stamp = '2026-10-17T00:00:00Z';
const delivery = {
  id: 'd'.repeat(24),
  mode: 'version',
  status: 'COMPLETE',
  source: { tag: 'v2' },
  base: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) },
  target: 'c'.repeat(40),
  acceptedInternal: 'e'.repeat(40),
  finishedAt: stamp,
  issues: [],
  taskIds: ['task'],
};

test('saved preservation rules are not described as unsaved merely because the baseline is not activated', () => {
  const snapshot = {
    config: { mode: 'version', internalPaths: ['README.md'], sourceBranch: 'main', targetBranch: 'main' },
  };
  const html = setupConfiguration(snapshot, esc, sha, button, {
    report: {
      upstream: 'a'.repeat(40),
      internal: 'b'.repeat(40),
      valid: true,
      files: [{ path: 'README.md', kind: 'modified', category: 'internal' }],
    },
  });
  assert.doesNotMatch(html, /本次内部保留范围（尚未保存）/);
  assert.match(html, /data-saved-rules/);
});

test('completed history explains persisted acceptance and loaded execution records without inventing step events', () => {
  const record = {
    delivery,
    tasks: [{ id: 'task', status: 'SUCCEEDED', finishedAt: stamp, steps: [] }],
    missingTasks: [],
  };
  const html = attempts(5, record, null, true, { config: { mode: 'version' } });
  assert.match(html, /data-step-key="acceptance-save"[^>]*data-operation-state="DONE"/);
  assert.match(html, /结果已记录/);
  assert.match(html, /未单独采集/);
  assert.match(html, /data-step-key="execution-record"[^>]*data-operation-state="DONE"/);
  const missing = attempts(5, { ...record, tasks: [], missingTasks: ['task'] }, null, true, {});
  assert.match(missing, /data-step-key="execution-record"[^>]*data-operation-state="UNRECORDED"/);
  const pending = attempts(
    5,
    { ...record, delivery: { ...delivery, status: 'CODE_ACCEPTED_PENDING_METADATA' } },
    null,
    false,
    {},
  );
  assert.doesNotMatch(pending, /data-step-key="acceptance-save"[^>]*data-operation-state="DONE"/);
});

test('the primary failure action leads to the missing credential and does not claim an unknown PR never existed', () => {
  const d = {
    ...delivery,
    status: 'PR_REQUIRED',
    acceptedInternal: undefined,
    prCreation: { marker: 'intent', status: 'RESULT_UNKNOWN' },
  };
  const snapshot = {
    config: {},
    state: { active: d, automation: { id: 'r', status: 'FAILED' } },
    operation: {
      deliveryId: d.id,
      status: 'FAILED',
      error: { code: 'ISSUE_AUTH_REQUIRED', message: '认证未提供' },
      steps: [],
    },
  };
  const html = actionBar(
    { stage: 3, text: '修正当前错误后恢复原轮次', action: 'resume-sync', label: '恢复原同步 →' },
    false,
    snapshot,
  );
  assert.match(html, /data-repair="platform"/);
  assert.match(html, /内部平台认证/);
  assert.doesNotMatch(html, /内部 PR 尚未创建/);
  assert.doesNotMatch(actionBar({ stage: 3 }, true, snapshot), /data-repair/);
});

test('persistence repair takes precedence over an older credential failure', () => {
  const snapshot = {
    state: { active: { ...delivery, status: 'PR_REQUIRED', error: { code: 'ISSUE_AUTH_REQUIRED' } } },
    operation: {
      deliveryId: delivery.id,
      persistence: { status: 'FAILED' },
      status: 'FAILED',
      error: { code: 'ISSUE_AUTH_REQUIRED' },
    },
  };
  const html = actionBar(
    { text: '先保存审计记录', action: 'persist-task', label: '补存记录' },
    false,
    snapshot,
  );
  assert.doesNotMatch(html, /data-repair="platform"/);
  assert.match(html, /data-action="persist-task"/);
});
test('legacy completion uses its real terminal event without inventing a completion date', () => {
  const d = { ...delivery, finishedAt: undefined };
  const record = { delivery: d, tasks: [], events: [{ deliveryId: d.id, stage: 'COMPLETE', time: stamp }] };
  assert.match(
    attempts(5, record, null, true, {}),
    /data-step-key="acceptance-save"[^>]*data-operation-state="DONE"/,
  );
  assert.match(
    attempts(5, { ...record, events: [] }, null, true, {}),
    /data-step-key="acceptance-save"[^>]*data-operation-state="UNRECORDED"/,
  );
});

test('history remains manually open when automatic progress changes the active delivery', () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: (key) => (key === 'repo-sync-history-open:default:binding' ? 'true' : null),
  };
  try {
    const history = { dataset: { persistDetails: 'history' }, open: false };
    const content = {
      dataset: { binding: 'binding' },
      querySelectorAll: (selector) => (selector === '[data-persist-details]' ? [history] : []),
    };
    restoreExpansion(content, {}, 'current', 'delivery-1');
    assert.equal(history.open, true);
    history.open = false;
    restoreExpansion(content, {}, 'current', 'delivery-2');
    assert.equal(history.open, true);
  } finally {
    if (previous) globalThis.sessionStorage = previous;
    else delete globalThis.sessionStorage;
  }
});
