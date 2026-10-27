import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TeamAssignment } from '../../src/team-ui/TeamAssignment';

it('shows environment and role, disables incompatible members and refuses to confirm an unsaved correction', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const context: any = { currentIssue: { repo: 'fixture/repo', number: 1, state: 'open', assignees: [] }, sourceVersion: 'source',
    assignmentOptions: { groupName: 'fixture', members: ['alice', 'bob'], eligibleMembers: ['bob'], preferredLogin: 'bob',
      affectedSystems: ['windows'], systemsSource: 'human', recommendationReason: 'Windows 环境兼容；核心方案职责优先',
      profiles: [{ login: 'alice', system: 'macos', role: 'member', weight: 2 }, { login: 'bob', system: 'windows', role: 'core-planner', weight: 1 }],
      excluded: [{ login: 'alice', reason: '系统不兼容' }] } };
  const host = { assignIssue: vi.fn() } as any;
  const render = (busy: boolean) => act(async () => root.render(<TeamAssignment context={context} host={host} busy={busy} act={async work => { await work(); }} />));
  try {
    await render(false);
    const select = node.querySelector<HTMLSelectElement>('[aria-label="指派给组员"]')!;
    expect(select.value).toBe('');
    expect(select.querySelector<HTMLOptionElement>('option[value="alice"]')!.disabled).toBe(true);
    expect(select.querySelector('option[value="bob"]')!.textContent).toContain('Windows · 核心方案');
    expect(node.textContent).toContain('系统不兼容');
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === '采用推荐人选')!.click());
    expect(select.value).toBe('bob');
    await render(true);
    const button = [...node.querySelectorAll('button')].find(button => button.textContent === '指派任务')!;
    expect(button.disabled).toBe(true); expect(host.assignIssue).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); }
});
