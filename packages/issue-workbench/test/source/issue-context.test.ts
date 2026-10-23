import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyIssueContext, issueContextFor } from '../../src/classification/issue-context.js';
import type { IssueClassification } from '../../src/model/issue-coordination.js';

test('content rules distinguish affected systems, comparisons, unset template choices and lack of evidence', () => {
  for (const [body, origin, systems] of [
    ['code-agent 在 win11 无法正常运行', 'internal', ['windows']],
    ['内部版本使用 codehub；公开版不涉及此功能。', 'unknown', []],
    ['Windows 失败但 macOS 正常', 'unknown', ['windows']],
    ['macOS 崩溃。Windows 没有问题。', 'unknown', ['macos']],
    ['Ubuntu 与 Windows 都会崩溃', 'unknown', ['windows', 'other']],
    ['- [ ] Windows\n- [ ] macOS\n- [x] Linux', 'unknown', ['other']],
    ['<!-- CodeHub Windows -->\n没有提供运行环境。', 'unknown', []],
    ['这只是共性问题，与运行系统无关。', 'common', []],
    ['codeagent 的问题，和外部版本是否相关尚不确定。', 'unknown', []],
  ] as const) {
    const result = classifyIssueContext({ title: '无法启动', body });
    assert.equal(result.origin, origin, body);
    assert.deepEqual(result.systems, systems, body);
    assert.ok([...result.originEvidence, ...result.systemEvidence].every(quote => body.includes(quote)));
  }
});

test('a new body supersedes title evidence and stale model context never survives a source edit or unavailable fact', () => {
  const fact = { id: 'id', number: 1, title: '无法启动', updatedAt: 'new', state: 'OPEN', labels: [], url: '' };
  const result: IssueClassification = { id: 'old', model: 'cat', generatedAt: 'old', evidence: '',
    source: { provider: 'github', instance: 'https://github.com', repositoryId: 'r', issueId: 'id', number: 1, updatedAt: 'old', bodySha256: '' },
    labels: { area: [], kind: [], symptom: [], environment: [] }, context: classifyIssueContext({ title: 'CodeHub Windows 错误', body: '' }) };
  assert.equal(issueContextFor(fact, result).origin, 'unknown');
  assert.equal(issueContextFor({ ...fact, updatedAt: 'old' }, result).origin, 'internal');
  assert.equal(issueContextFor({ ...fact, updatedAt: 'old', body: '社区版在 macOS 崩溃' }, result).origin, 'external');
  assert.equal(issueContextFor({ ...fact, updatedAt: 'old', unavailable: true }, result).origin, 'unknown');
});

test('explicit reported environments take precedence over background platforms and code examples', () => {
  // Public issue #279: Linux/Windows installers exist; the missing installer affects macOS.
  const body = '## 问题描述\n当前项目提供了 Linux 和 Windows 的安装脚本，但没有 macOS 专用安装脚本。\n'
    + '```bash\nfail "This script is for Linux only"\n```\n## 环境\n- macOS (Darwin)\n- Node.js 20+';
  const result = classifyIssueContext({ title: 'macOS 缺少安装脚本', body });
  assert.deepEqual(result.systems, ['macos']);
  assert.deepEqual(result.systemEvidence, ['- macOS (Darwin)']);
  assert.deepEqual(classifyIssueContext({ title: '启动失败', body:
    '## Environment\nWindows 11 和 Ubuntu\n## Suggested fix\n参考 macOS 实现' }).systems, ['windows', 'other']);
  assert.deepEqual(classifyIssueContext({ title: 'Windows 启动失败', body:
    '## 环境\n未填写\n## 建议\n参考 Linux 实现' }).systems, ['windows']);
  assert.deepEqual(classifyIssueContext({ title: '启动失败', body:
    '## 环境\n- [ ] Windows\n- [x] macOS\n- Linux 正常' }).systems, ['macos']);
  assert.deepEqual(classifyIssueContext({ title: 'macOS 启动失败', body:
    '参考代码：\n```sh\nif linux; then echo Windows; fi\n```' }).systems, ['macos']);
});
