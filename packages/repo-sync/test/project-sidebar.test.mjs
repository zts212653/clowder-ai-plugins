import assert from 'node:assert/strict';
import test from 'node:test';
import { projectView } from '../web/project-view.mjs';
test('project navigation exposes every project with its own directly adjacent settings action', () => {
  const html = projectView({ workspace: { projects: [{ id: 'default', name: '核心项目', mode: 'continuous' }, { id: 'a'.repeat(24), name: '定制项目', mode: 'version' }] } }, 'default');
  assert.match(html, /aria-label="项目侧栏"/);
  assert.match(html, /data-project-settings="default"/);
  assert.match(html, /data-project-settings="aaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(html, /aria-label="核心项目的仓库设置"/);
});
