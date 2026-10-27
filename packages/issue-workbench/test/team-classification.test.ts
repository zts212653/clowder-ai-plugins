import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTeamClassifications } from '../src/team-ui/classification-overlay.js';
import { issueCategory, type CoordinationSnapshot } from '../src/model/issue-coordination.js';
import type { TeamClassification } from '../src/team/records.js';
import { setup } from './helpers/team-fixture.js';

function fixture() {
  const s = setup(), issue = s.issues[0]; s.analysis.category = 'Agent 运行';
  const result: TeamClassification = { id: 'result', issue, analysis: s.analysis, catId: 'selected-cat', recordedAt: Date.now(), bodySha256: 'body-digest' };
  const snapshot: CoordinationSnapshot = { relations: [], sources: [{
    profile: { id: 'github', provider: 'github', instance: 'https://github.com', repositoryId: 'repo-id', repository: issue.repo, name: 'Repo', visibility: 'public' },
    preference: { revision: 1, value: { name: 'Repo', enabled: true, branch: '', base: '' } }, work: [],
    issues: [{ id: issue.id, number: issue.number, title: issue.title, state: 'OPEN', labels: [], updatedAt: issue.updatedAt!, url: issue.url }],
  }] };
  return { snapshot, result };
}
test('one persisted cat result projects into queue categories and detail without altering source or local records', () => {
  const { snapshot, result } = fixture(), before = structuredClone(snapshot);
  const source = withTeamClassifications(snapshot, [result]).sources[0];
  assert.equal(issueCategory({ source, fact: source.issues[0] }).label, 'Agent 运行');
  assert.equal(source.classifications![0].evidence, result.analysis.evidence);
  assert.equal(source.classifications![0].source.bodySha256, result.bodySha256);
  assert.match(source.classifications![0].model, /selected-cat/);
  assert.deepEqual(snapshot, before);
  source.issues[0].labels = ['feature:F123'];
  assert.equal(issueCategory({ source, fact: source.issues[0] }).label, '随 Feature 处理');
});
test('classification projection cannot cross provider, instance, repository, source revision or denied access', () => {
  for (const change of [
    (s: CoordinationSnapshot) => { s.sources[0].profile.provider = 'internal'; },
    (s: CoordinationSnapshot) => { s.sources[0].profile.instance = 'https://enterprise.test'; },
    (s: CoordinationSnapshot) => { s.sources[0].profile.repository = 'another/repo'; },
    (s: CoordinationSnapshot) => { s.sources[0].issues[0].id = 'another-issue'; },
    (s: CoordinationSnapshot) => { s.sources[0].issues[0].updatedAt = '2026-10-15T00:00:00Z'; },
    (s: CoordinationSnapshot) => { s.sources[0].issues[0].body = 'Changed body'; },
    (s: CoordinationSnapshot) => { s.sources[0].issues[0].unavailable = true; },
    (s: CoordinationSnapshot) => { s.sources[0].error = '来源未授权'; },
  ]) {
    const { snapshot, result } = fixture(); change(snapshot);
    assert.equal(withTeamClassifications(snapshot, [result]).sources[0].classifications, undefined);
  }
});

test('persisted analyses classify origin and affected systems from the issue description, including legacy results', () => {
  for (const [body, origin, systems] of [
    ['CodeAgent 在 Windows 11 启动报错，macOS 正常。', 'internal', ['windows']],
    ['CodeHub clone fails on Ubuntu Linux.', 'internal', ['other']],
    ['开源版在 macOS Sonoma 安装失败。', 'external', ['macos']],
    ['内部版和开源版都能复现：Windows 和 Mac 均崩溃。', 'common', ['windows', 'macos']],
    ['窗口无法关闭，console.log 报错。', 'unknown', []],
    ['不涉及 codeagent，社区版在 Windows 报错。', 'external', ['windows']],
    ['MAC address lookup failed; window.close() is undefined.', 'unknown', []],
  ] as const) {
    const { snapshot, result } = fixture();
    result.issue.body = body;
    const before = structuredClone(result);
    const proposal = withTeamClassifications(snapshot, [result]).sources[0].classifications![0];
    assert.equal(proposal.context?.origin, origin, body);
    assert.deepEqual(proposal.context?.systems, systems, body);
    assert.equal(proposal.context?.basis, 'description');
    assert.deepEqual(result, before, 'projection must not rewrite the persisted analysis');
  }
});

test('new analysis instructions ask for content-based origin and system evidence without granting new actions', async () => {
  const s = setup();
  await s.runtime().invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'context-test' }, s.caller('requester'));
  const text = [...s.sends.values()][0].draft.payload.elements[0].payload.text;
  assert.match(text, /codeagent.*codehub/i);
  assert.match(text, /Windows.*macOS.*其他系统/);
  assert.match(text, /证据不足.*待判断/);
  assert.match(text, /此任务不授权修代码/);
  assert.match(text, /category 仅从以下名称中选一个/);
  assert.match(text, /多个同等独立问题/);
  assert.match(text, /界面交互.*不含/);
  assert.match(text, /测试入口在 PowerShell/);
});
