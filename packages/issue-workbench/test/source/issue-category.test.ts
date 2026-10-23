import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueCategory, issueCategoryCounts, matchesIssueCategory, newInvestigation, type CoordinationSource } from '../../src/model/issue-coordination.js';

function fixture(areas = ['界面交互']) {
  const fact = { id: 'one', number: 1, title: 'Reported failure', state: 'OPEN' as const, updatedAt: '2026-10-22', labels: [] as string[], url: 'https://example.test/1' };
  const preference = { enabled: true, name: 'Source', branch: '', base: '' };
  const source: CoordinationSource = { profile: { id: 'source', provider: 'github', instance: 'https://github.com', repositoryId: 'repo', repository: 'test/repo', name: 'Source', visibility: 'public' },
    preference: { revision: 0, value: preference }, issues: [fact], work: [], classifications: [{ id: 'candidate', model: 'fixture', generatedAt: fact.updatedAt,
      source: { provider: 'github', instance: 'https://github.com', repositoryId: 'repo', issueId: fact.id, number: 1, updatedAt: fact.updatedAt, bodySha256: 'fixture' },
      labels: { area: areas, kind: [], symptom: [], environment: [] }, evidence: 'Reported evidence' }] };
  const value = newInvestigation({ sourceId: 'source', issueId: 'one', number: 1 }, fact.title, fact.updatedAt, preference);
  return { source, fact, value };
}
test('saved primary category drives the same partition and filter; Feature and unavailable states retain priority', () => {
  const { source, fact, value } = fixture();
  source.work = [{ revision: 1, value: { ...value, module: '猫猫协作', tags: '模块：界面交互；旧标记' } }];
  const row = { source, fact };
  assert.equal(issueCategory(row).label, '猫猫协作');
  assert.equal(matchesIssueCategory(row, 'area:猫猫协作'), true);
  assert.deepEqual(issueCategoryCounts([row]), [{ key: 'area:猫猫协作', label: '猫猫协作', count: 1 }]);
  fact.labels = ['feature:F123'];
  assert.equal(issueCategory(row).key, 'feature');
  assert.equal(issueCategory({ source, fact: { ...fact, unavailable: true } }).key, 'unavailable');
  assert.equal(source.work[0].value.tags, '模块：界面交互；旧标记');
});
test('multiple candidate subjects and unknown legacy names do not silently become confirmed primary categories', () => {
  const { source, fact, value } = fixture(['Agent 运行', '工具与连接器']);
  assert.equal(issueCategory({ source, fact }).key, 'unclassified');
  source.work = [{ revision: 1, value: { ...value, module: '任意旧名称' } }];
  assert.equal(issueCategory({ source, fact }).key, 'unclassified');
  assert.equal(source.work[0].value.module, '任意旧名称');
  source.work[0].value.module = '待判断';
  source.classifications![0].labels.area = ['界面交互'];
  assert.equal(issueCategory({ source, fact }).key, 'unclassified');
});
