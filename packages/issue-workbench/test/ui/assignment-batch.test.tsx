import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AssignmentBatchBoard } from '../../src/team-ui/AssignmentBatchBoard';

// jsdom has no layout; the packed browser journey checks actual scroll visibility.
HTMLElement.prototype.scrollIntoView = vi.fn();

async function mount(delivery = 'assignment') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const item = (number: number, status = 'ready'): any => ({ issue: { id: String(number), repo: 'fixture/repo', number, title: '问题 ' + number, assignees: status === 'retained' ? ['bob'] : [], url: 'https://github.com/fixture/repo/issues/' + number },
    status, included: status !== 'retained', category: 'Agent 运行', score: 7, login: 'alice', options: { members: ['alice', 'bob', 'windows'], eligibleMembers: ['alice', 'bob'], preferredLogin: 'alice', affectedSystems: ['macos'], recommendationReason: 'macOS 普通成员加权分配', excluded: [{ login: 'windows', reason: '系统不兼容' }] } });
  let batch: any = { id: 'batch', revision: 1, status: 'draft', initiator: 'system', delivery, createdAt: 1, items: [item(1), item(2, 'needs-analysis'), item(3, 'retained')] };
  const host: any = {
    getAssignmentBatch: vi.fn(async () => structuredClone(batch)), summary: vi.fn(async () => ({ settings: {}, analysisCats: [] })),
    editAssignmentBatch: vi.fn(async (args: any) => { const row = batch.items.find((i: any) => i.issue.id === args.issueId); Object.assign(row, { login: args.login, included: args.included }); batch.revision++; return structuredClone(batch); }),
    confirmAssignmentBatch: vi.fn(async () => { batch.status = 'running'; batch.revision++; return structuredClone(batch); }),
  };
  await act(async () => root.render(<AssignmentBatchBoard host={host} />));
  const button = (label: string) => [...node.querySelectorAll('button')].find(b => b.textContent === label)!;
  return { node, host, button, async close() { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); } };
}
it('restores the complete board, allows compatible adjustments, and never confirms unseen pending items', async () => {
  const v = await mount();
  try {
    expect(v.node.textContent).toContain('system'); expect(v.node.textContent).toContain('已有负责人');
    expect(v.button('核对并派工').disabled).toBe(true);
    const select = v.node.querySelector<HTMLSelectElement>('[aria-label="调整 fixture/repo#1 指派成员"]')!;
    expect(select.querySelector<HTMLOptionElement>('[value="windows"]')!.disabled).toBe(true);
    await act(async () => { select.value = 'bob'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(v.host.editAssignmentBatch).toHaveBeenCalledWith(expect.objectContaining({ login: 'bob', expectedRevision: 1 }));
    const include = v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#2"]')!;
    await act(async () => include.click());
    expect(v.button('核对并派工').disabled).toBe(false);
    await act(async () => v.button('核对并派工').click());
    expect(v.host.confirmAssignmentBatch).not.toHaveBeenCalled();
    expect(v.node.textContent).toContain('即将设置 1 个 Issue 的 GitHub 负责人');
    expect(document.activeElement).toBe(v.node.querySelector('[role="alertdialog"]'));
    await act(async () => v.button('返回调整').click());
    expect(document.activeElement).toBe(v.button('核对并派工'));
    expect(v.node.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => v.button('核对并派工').click());
    await act(async () => v.button('确认批量派工').click());
    expect(v.host.confirmAssignmentBatch).toHaveBeenCalledWith({ id: 'batch', expectedRevision: 3 });
    expect(v.node.textContent).toContain('执行中');
  } finally { await v.close(); }
});
it('refreshing or closing the board does not itself dispatch', async () => {
  const v = await mount();
  try { await act(async () => v.button('刷新进度').click()); expect(v.host.confirmAssignmentBatch).not.toHaveBeenCalled(); }
  finally { await v.close(); }
});
it('shows the frozen invitation delivery in confirmation instead of promising GitHub assignees', async () => {
  const v = await mount('invitation');
  try {
    await act(async () => v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#2"]')!.click());
    await act(async () => v.button('核对并派工').click());
    expect(v.node.querySelector('[role="alertdialog"]')?.textContent).toContain('即将发送 1 条任务邀请');
    expect(v.node.querySelector('[role="alertdialog"]')?.textContent).toContain('不设置 GitHub 负责人');
    expect(v.host.confirmAssignmentBatch).not.toHaveBeenCalled();
  } finally { await v.close(); }
});
it('shows only the clicked participation change while saving and retains it on success', async () => {
  const v = await mount();
  try {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const save = v.host.editAssignmentBatch.getMockImplementation()!;
    v.host.editAssignmentBatch.mockImplementation(async (args: any) => { await pending; return save(args); });
    const first = v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#1"]')!;
    const second = v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#2"]')!;
    await act(async () => second.click());
    expect(second.checked).toBe(false);
    expect(first.checked).toBe(true);
    expect(v.node.textContent).toContain('正在保存 #2 的调整');
    expect(v.button('核对并派工').disabled).toBe(true);
    await act(async () => complete());
    expect(second.checked).toBe(false);
    expect(first.checked).toBe(true);
    expect(v.button('核对并派工').disabled).toBe(false);
    expect(v.node.textContent).not.toContain('正在保存');
    expect(v.host.confirmAssignmentBatch).not.toHaveBeenCalled();
  } finally { await v.close(); }
});
it('restores the edited participation after a failed save without changing other rows', async () => {
  const v = await mount();
  try {
    let fail!: (error: Error) => void;
    v.host.editAssignmentBatch.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#1"]')!;
    const second = v.node.querySelector<HTMLInputElement>('[aria-label="本次参与 fixture/repo#2"]')!;
    await act(async () => second.click());
    expect(second.checked).toBe(false);
    expect(first.checked).toBe(true);
    await act(async () => fail(new Error('保存失败，请刷新后重试')));
    expect(second.checked).toBe(true);
    expect(first.checked).toBe(true);
    expect(second.disabled).toBe(false);
    expect(v.node.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
    expect(document.activeElement).toBe(v.node.querySelector('[role="alert"]'));
    expect(v.node.textContent).not.toContain('正在保存');
    expect(v.host.confirmAssignmentBatch).not.toHaveBeenCalled();
  } finally { await v.close(); }
});
