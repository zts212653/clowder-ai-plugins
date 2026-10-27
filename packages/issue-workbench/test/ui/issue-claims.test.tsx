import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { IssueSourceState } from '../../src/ui/IssueSourceState';

it('shows unclaimed, all claimants, and unknown legacy ownership distinctly on Open issues', () => {
  const view = (assignees?: string[]) => renderToStaticMarkup(<IssueSourceState fact={{ state: 'OPEN', assignees } as any} />);
  expect(view([])).toContain('未认领');
  expect(view(['alice', 'bob'])).toContain('已认领 · @alice、@bob');
  expect(view()).toContain('认领状态待更新');
  expect(view()).not.toContain('未认领');
});
it('does not advertise closed or inaccessible issues as available to claim', () => {
  for (const fact of [{ state: 'CLOSED', assignees: [] }, { state: 'OPEN', assignees: [], unavailable: true }])
    expect(renderToStaticMarkup(<IssueSourceState fact={fact} />)).not.toContain('未认领');
});
