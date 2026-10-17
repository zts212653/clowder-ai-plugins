import assert from 'node:assert/strict';
import test from 'node:test';
import { actionBar } from '../web/actionbar.mjs';

const policy = { text: '等待内部 PR 审核', label: '打开 PR', href: 'https://codehub.example/pull/1' };

test('pause-after-current-delivery is a primary visible workbench action while a PR awaits review', () => {
  const html = actionBar(policy, false, {
    state: { automation: { id: 'run-1', status: 'WAITING_REVIEW' }, active: { id: 'delivery-1', status: 'WAITING_APPROVAL' } },
    config: { prTransport: 'manual' },
  });
  const pauseAt = html.indexOf('data-action="pause-sync"');
  assert.notEqual(pauseAt, -1);
  assert.ok(pauseAt < html.indexOf('<details'), 'pause is outside the collapsed cadence settings');
  assert.match(html, /本笔完成后暂停/);
  assert.match(html, /class="next-action now"/);
  assert.match(html, /轮到你了/);
  assert.match(html, /data-persist-details="continuation"/);
  assert.equal((html.match(/data-action="pause-sync"/g) ?? []).length, 1);
});

test('historical runs and already paused runs do not show a live pause action', () => {
  const snapshot = { state: { automation: { id: 'run-1', status: 'PAUSED' } } };
  assert.equal(actionBar(policy, true, snapshot), '');
  assert.doesNotMatch(actionBar(policy, false, snapshot), /data-action="pause-sync"/);
});

test('failures are presented as user work instead of a system wait', () => {
  for (const code of ['BASELINE_MISMATCH', 'PR_CREATE_RESULT_UNKNOWN', 'LEDGER_WRITE_FAILED']) {
    const html = actionBar(
      { text: '修正当前错误后恢复', action: 'resume-sync', label: '恢复原同步 →' },
      false,
      { state: { active: { id: 'delivery-1', error: { code, message: '需要处理' } } }, config: {} },
    );
    assert.match(html, /需要你处理/);
    assert.doesNotMatch(html, /<p class="now-kicker">系统正在处理<\/p>/);
  }
});

test('record persistence and stop uncertainty are explicit user actions', () => {
  const policy = { text: '处理记录', action: 'persist-operation', label: '补存原任务记录' };
  assert.match(actionBar(policy, false, { operation: { persistence: { status: 'FAILED' } }, state: {} }), /需要你处理/);
  assert.match(actionBar({ text: '核对停止结果', action: 'recover', label: '核对原交付' }, false, { operation: { status: 'STOP_UNCONFIRMED' }, state: {} }), /需要你处理/);
});
