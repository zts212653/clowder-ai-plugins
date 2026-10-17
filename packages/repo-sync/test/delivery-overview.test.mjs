import assert from 'node:assert/strict';
import test from 'node:test';
import { workflow } from '../web/workflow.mjs';

test('current PR business summary shows development/main/internal counts and concrete Issue links before execution evidence', () => {
  const d = { id: 'a'.repeat(24), mode: 'continuous', source: { number: 1405, title: 'feat(site)', url: 'https://github.com/demo/core/pull/1405', developmentCommitCount: 18 },
    base: { upstream: 'b'.repeat(40), internal: 'c'.repeat(40) }, target: 'd'.repeat(40), commits: ['d'.repeat(40)],
    status: 'WAITING_APPROVAL', prUrl: 'https://internal.example/core/merge_requests/9', branch: 'sync/test',
    commitPolicy: { strategy: 'rewrite', identity: { name: 'Sync', email: 'sync@example.invalid' } }, internalCommitCount: 18,
    developmentMappings: Array.from({ length: 18 }, (_, i) => ({ source: i.toString(16).padStart(40, '0'), internal: (i + 100).toString(16).padStart(40, '0') })),
    issues: [{ sourceId: 'issue-7', number: 7, title: '修复读取 <script>', url: 'https://github.com/demo/core/issues/7', relation: 'closes' }],
    issueMappings: { 'issue-7': { internalId: '71', url: 'https://internal.example/core/issues/71' } } };
  const snapshot = { config: { mode: 'continuous', targetBranch: 'main' }, state: { active: d, issues: {}, templates: { title: 'PR', body: '' } } };
  const record = { delivery: d, configurations: [], tasks: [], issues: [], missingTasks: [], taskPage: {}, events: [] };
  const html = workflow(snapshot, record, false);
  assert.match(html, /PR 开发提交[\s\S]*18/);
  assert.match(html, /main 落地提交[\s\S]*1/);
  assert.match(html, /内部候选提交[\s\S]*18/);
  assert.match(html, /关联 Issue[\s\S]*1/);
  assert.match(html, /展开查看外部 → 内部映射与关单条件/);
  assert.match(html, /这里是业务对象映射；底层命令和重试记录请查看对应阶段的执行详情/);
  assert.match(html, /delivery-object-guide/);
  assert.match(html, /准备交付/);
  assert.ok(html.indexOf('class="next-action now"') < html.indexOf('data-flow-canvas'));
  assert.match(html, /修复读取 &lt;script&gt;/);
  assert.match(html, /内部 #71/);
  assert.ok(html.indexOf('修复读取') < html.indexOf('journey-flow'));
  assert.match(html, /放弃本笔并重新同步/);
  assert.doesNotMatch(workflow(snapshot, record, true), /data-form="cancel-delivery"/);
});
