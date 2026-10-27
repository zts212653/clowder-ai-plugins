import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TeamAssignment } from '../../src/team-ui/TeamAssignment';
import { TeamRecordView } from '../../src/team-ui/TeamRecordView';

function fixture(assignees: string[] = []) {
  const issue = { repo: 'fixture/repo', number: 1, state: 'open', assignees, author: 'reporter', url: 'https://github.com/fixture/repo/issues/1' };
  const options = { groupName: 'fixture', members: ['alice', 'bob'], eligibleMembers: ['alice'], preferredLogin: 'alice',
    affectedSystems: ['macos'], recommendationReason: '普通成员加权分配', profiles: [], excluded: [{ login: 'bob', reason: '系统不兼容' }] };
  const context: any = { currentIssue: issue, sourceVersion: 'current-source', assignmentOptions: options };
  const row = (status: 'invited' | 'assigned'): any => ({ kind: 'assignment', id: 'old-record', revision: 7, issue,
    sourceVersion: 'old-source', sourceStale: true, currentIssue: issue, assignmentOptions: options, sharedReceipts: [],
    assignment: { status, login: 'alice', delivery: status === 'invited' ? 'invitation' : 'assignment', commentAttempted: true, commentId: 'comment-old' } });
  return { context, row };
}

async function mount(context: any, row?: any) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const host = { assignIssue: vi.fn().mockResolvedValue({ id: 'new-record' }), assign: vi.fn() } as any;
  await act(async () => root.render(<TeamAssignment context={context} row={row} host={host} busy={false} act={async work => { await work(); }} />));
  const button = (label: string) => [...node.querySelectorAll('button')].find(b => b.textContent === label)!;
  return { node, host, button, async close() { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); } };
}

it('requires an explicit recipient even when there is a recommendation', async () => {
  const view = await mount(fixture().context);
  try {
    const select = view.node.querySelector<HTMLSelectElement>('[aria-label="指派给组员"]')!;
    expect(select.value).toBe(''); expect(view.button('指派任务').disabled).toBe(true);
    await act(async () => view.button('采用推荐人选').click());
    expect(select.value).toBe('alice'); expect(view.button('指派任务').disabled).toBe(false);
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(view.button('指派任务').disabled).toBe(true); expect(view.host.assignIssue).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

for (const status of ['invited', 'assigned'] as const) it(`allows a fresh explicit assignment after ${status} when GitHub is unassigned`, async () => {
  const f = fixture(); const old = f.row(status); const before = structuredClone(old); const view = await mount(f.context, old);
  try {
    expect(view.node.querySelector('[aria-label="指派给组员"]')).not.toBeNull();
    expect(view.node.querySelector<HTMLSelectElement>('[aria-label="派工方式"]')!.value).toBe('assignment');
    await act(async () => view.button('采用推荐人选').click());
    await act(async () => view.button('指派任务').click());
    await act(async () => view.button('确认指派').click());
    expect(view.host.assign).not.toHaveBeenCalled();
    expect(view.host.assignIssue).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice', delivery: 'assignment', sourceVersion: 'current-source' }));
    expect(view.host.assignIssue.mock.calls[0][0].requestId).toBeTruthy(); expect(old).toEqual(before);
  } finally { await view.close(); }
});

it('retains a return/reassignment entry for an existing GitHub owner without overwriting them', async () => {
  const f = fixture(['alice']); const view = await mount(f.context, f.row('invited'));
  try {
    const link = [...view.node.querySelectorAll('a')].find(a => a.textContent?.includes('退回或改派'));
    expect(link?.href).toBe('https://github.com/fixture/repo/issues/1');
    expect(view.node.textContent).toContain('移除自己');
    expect(view.node.textContent).toContain('刷新团队结果');
    expect(view.host.assignIssue).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

it('restores the committed recipient while an uncertain publication is being recovered', async () => {
  const f = fixture(); const row = f.row('invited');
  row.assignment.status = 'pending'; row.sourceStale = false;
  const view = await mount(f.context, row);
  try {
    const select = view.node.querySelector<HTMLSelectElement>('[aria-label="指派给组员"]')!;
    expect(select.disabled).toBe(true); expect(select.value).toBe('alice');
    expect(view.button('通知成员接手').disabled).toBe(false);
    await act(async () => view.button('通知成员接手').click());
    await act(async () => view.button('确认发送邀请').click());
    expect(view.host.assign).toHaveBeenCalledWith({ id: 'old-record', expectedRevision: 7, login: 'alice', delivery: 'invitation' });
    expect(view.host.assignIssue).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

it('does not label a historical invitation as still awaiting acceptance after GitHub has an owner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div'); const root = createRoot(node); const f = fixture(['alice']);
  try {
    await act(async () => root.render(<TeamRecordView row={f.row('invited')} />));
    expect(node.textContent).not.toContain('等待成员接手');
    expect(node.textContent).toContain('历史邀请'); expect(node.textContent).toContain('@alice');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
