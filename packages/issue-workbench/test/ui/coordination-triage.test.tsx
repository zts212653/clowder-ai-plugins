import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CoordinationWorkbench } from '../../src/ui/CoordinationWorkbench';
import { newInvestigation, type CoordinationHost, type CoordinationSnapshot } from '../../src/model/issue-coordination';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());
const fact = { id: 'issue-1', number: 1, title: '工作台重复加载', state: 'OPEN' as const,
  updatedAt: '2026-10-22T00:00:00Z', labels: [], url: 'https://github.com/fixture/repo/issues/1', body: '重复加载的证据' };
const profile = { id: 'source', name: '测试仓', provider: 'github' as const, instance: 'https://github.com',
  repositoryId: 'repo-1', repository: 'fixture/repo', visibility: 'public' as const };
const preference = { name: '测试仓', enabled: true, branch: '', base: '' };
async function setup(legacy = false, description?: string) {
  const value = { ...newInvestigation({ sourceId: 'source', issueId: fact.id, number: 1 }, fact.title, fact.updatedAt, preference),
    ...(legacy ? { notes: '保留的人工说明', tags: '人工分类', module: '人工模块', branch: 'old-branch', base: 'old-base', patch: 'old-patch',
      verification: 'passed' as const, verificationEvidence: '原验证证据' } : {}) };
  const snapshot: CoordinationSnapshot = { relations: [], sources: [{ profile, preference: { revision: 0, value: preference },
    issues: [{ ...fact, body: undefined }], work: legacy ? [{ revision: 3, value }] : [], classifications: [{ id: 'result-1', model: 'test-model',
      generatedAt: fact.updatedAt, source: { ...profile, issueId: fact.id, number: 1, updatedAt: fact.updatedAt, bodySha256: 'test' },
      labels: { area: ['界面交互'], kind: ['缺陷'], symptom: ['重复加载'], environment: [] }, evidence: fact.body }] }] };
  const saveWork = vi.fn(async (next, revision) => { snapshot.sources[0].work = [{ revision: revision + 1, value: next }]; return snapshot.sources[0].work[0]; });
  const host: CoordinationHost = { load: async () => snapshot, detail: async () => ({ fact: { ...fact, body: description ?? fact.body } }), saveWork,
    savePreference: vi.fn(), saveRelation: vi.fn() };
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<CoordinationWorkbench host={host} />));
  return { node, value, saveWork, snapshot, close: () => { act(() => root.unmount()); node.remove(); } };
}
it('shows automatic classification first, prefills optional corrections and never demands repair fields or autosaves', async () => {
  const s = await setup();
  try {
    const editor = s.node.querySelector('[aria-label="问题类别选择"]')!.closest('form')!;
    expect(editor.textContent).toContain('分类分析');
    expect(editor.querySelector('[aria-label="自动分类结果"]')?.textContent).toContain('重复加载的证据');
    expect(editor.querySelectorAll('input:not(details input), textarea:not(details textarea)').length).toBe(0);
    expect(editor.querySelector('[aria-label="模块"]')).toBeNull();
    expect(editor.querySelector('[aria-label="本地标记"]')).toBeNull();
    expect((editor.querySelector('[aria-label="问题类别选择"]') as HTMLSelectElement).selectedOptions[0].textContent).toContain('界面交互');
    expect(editor.querySelector('[aria-label="当前类别边界"]')?.textContent).toContain('猫猫协作');
    expect(s.node.querySelector('[role="combobox"]')?.closest('details')?.open).toBe(false);
    for (const label of ['目标分支', '验证代码基线', '修复 PR / 提交', '本仓验证', '补丁纳入', '验证证据 / 测试结果'])
      expect(editor.querySelector(`[aria-label="${label}"]`)).toBeNull();
    expect(s.node.textContent).not.toContain('本仓 · 待验证');
    expect(s.saveWork).not.toHaveBeenCalled();
  } finally { s.close(); }
});

it('fills origin and system from the loaded body without requiring another analysis or overwriting manual work', async () => {
  const s = await setup(true, 'CodeHub 在 Windows 11 无法正常启动，macOS 正常。');
  try {
    const context = s.node.querySelector('form [aria-label="问题来源与操作系统"]');
    expect(context?.textContent).toContain('内源问题');
    expect(context?.textContent).toContain('Windows');
    expect(context?.textContent).not.toContain('macOS');
    expect(s.node.querySelector('[aria-label="问题类别选择"]')!.closest('form')?.textContent).toContain('人工分类');
    expect(s.saveWork).not.toHaveBeenCalled();
  } finally { s.close(); }
});
it('saving a concise analysis preserves prior manual classification and hidden historical repair records', async () => {
  const s = await setup(true);
  try {
    const note = s.node.querySelector<HTMLTextAreaElement>('[aria-label="分析备注"]');
    expect(note).not.toBeNull();
    expect(s.node.querySelector('[aria-label="问题类别选择"]')!.closest('form')?.textContent).toContain('人工分类');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '仅补充派工依据');
      note!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => note!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(s.saveWork).toHaveBeenCalledWith({ ...s.value, notes: '仅补充派工依据' }, 3);
  } finally { s.close(); }
});

it('one explicit class selection changes grouping after save without generating duplicate tags', async () => {
  const s = await setup();
  try {
    const select = s.node.querySelector<HTMLSelectElement>('[aria-label="问题类别选择"]')!;
    await act(async () => { select.value = '猫猫协作'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(s.saveWork).not.toHaveBeenCalled();
    await act(async () => select.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(s.snapshot.sources[0].work[0].value.module).toBe('猫猫协作');
    expect(s.snapshot.sources[0].work[0].value.tags).toBe('');
    expect(s.node.querySelector('[aria-label="问题类别"]')?.textContent).toContain('猫猫协作 · 1');
    expect(s.node.querySelector('[aria-label="问题类别"]')?.textContent).not.toContain('界面交互 · 1');
  } finally { s.close(); }
});
