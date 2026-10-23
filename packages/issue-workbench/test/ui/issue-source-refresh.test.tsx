import type { IssueSourceSnapshot } from '../../src/ui/../src/model/issue-source.js';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from '../ui-root';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IssueWorkbenchPreview } from '../../src/ui/IssueWorkbenchPreview';

const first = {
  number: 42,
  title: 'Issue 42',
  state: 'OPEN',
  url: 'https://github.com/zts212653/clowder-ai/issues/42',
  labels: [],
  updatedAt: new Date().toISOString(),
  fetchedAt: new Date().toISOString(),
  body: 'original body',
  comments: [],
  commentCount: 0,
  detailVersion: 'a'.repeat(64),
  reviewVersion: 'original',
};
const seed = { repo: 'zts212653/clowder-ai', fetchedAt: first.fetchedAt, issues: [first] };

import { emptyWork, STORAGE_KEY } from '../../src/ui/workbench-model';

let container: HTMLDivElement;
let root: Root;
const initial = {
  ...seed,
  revision: 1,
  lastCompleteAt: new Date().toISOString(),
  lastCheckedAt: new Date().toISOString(),
  failures: [],
  summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
};
function mockSource(next: IssueSourceSnapshot = initial, offline = false) {
  let refreshed = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/issues/'))
      return new Response(JSON.stringify({ detail: (refreshed ? next : initial).issues[0], failures: [] }));
    if (url.includes('/refresh')) {
      if (offline) throw new Error('offline');
      refreshed = true;
    }
    const snapshot = refreshed ? next : initial;
    return new Response(
      JSON.stringify({
        snapshot: { ...snapshot, issues: snapshot.issues.map(({ body, comments, ...index }) => index) },
      }),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it('refreshes real source facts while preserving focused unsaved edits and local acceptance', async () => {
  const records = { [first.number]: { ...emptyWork(), stage: 'resolved', solution: 'saved', evidence: 'evidence' } };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: true, records }));
  const updated = {
    ...initial,
    revision: 2,
    issues: initial.issues.map((f) =>
      f.number === first.number
        ? {
            ...f,
            state: 'CLOSED',
            body: 'remote edit',
            contentVersion: 'new',
            reviewVersion: 'new',
            detailVersion: 'b'.repeat(64),
          }
        : f,
    ),
    summary: { added: 0, changed: 1, closed: 1, reopened: 0 },
  };
  const fetcher = mockSource(updated);
  await act(async () => root.render(<IssueWorkbenchPreview />));
  await act(async () => button('解决方案').click());
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="解决方案"]')!;
  input.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'half written');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('更新')).toBeDefined();
  await act(async () => button('更新').click());
  expect(input.value).toBe('half written');
  expect(document.activeElement).toBe(input);
  expect(container.textContent).toContain('Closed · 已关闭');
  expect(container.textContent).toContain('来源有更新');
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).records[first.number]).toEqual(records[first.number]);
  expect(fetcher.mock.calls.some(([url]) => url.includes('/refresh'))).toBe(true);
});
it('keeps old content and last successful time on transport failure; retry remains available', async () => {
  mockSource(initial, true);
  await act(async () => root.render(<IssueWorkbenchPreview />));
  expect(button('更新')).toBeDefined();
  await act(async () => button('更新').click());
  expect(container.textContent).toContain('更新失败');
  expect(container.textContent).toContain(first.title);
  expect(button('重试').disabled).toBe(false);
});

it('pins the reading version until requested and marks newly fetched comments', async () => {
  const update = {
    ...initial,
    revision: 2,
    issues: initial.issues.map((f) =>
      f.number === first.number
        ? {
            ...f,
            body: 'changed body',
            bodyHTML: '<p>changed body</p>',
            labels: ['bug'],
            contentVersion: 'v2',
            detailVersion: 'b'.repeat(64),
            comments: [
              ...f.comments,
              {
                id: 'new-comment',
                author: 'new-author',
                body: 'new discussion',
                createdAt: '2026-10-12T00:00:00Z',
                updatedAt: '2026-10-12T00:00:00Z',
                lastEditedAt: null,
                url: first.url,
              },
            ],
            commentCount: f.commentCount + 1,
          }
        : f,
    ),
  };
  mockSource(update);
  await act(async () => root.render(<IssueWorkbenchPreview />));
  await act(async () => button('更新').click());
  expect(container.querySelector('[data-testid="issue-discussion"]')?.textContent).not.toContain('changed body');
  await act(async () => button('查看变化').click());
  expect(container.querySelector('[data-testid="issue-discussion"]')?.textContent).toContain('changed body');
  expect(container.querySelector('[data-comment-id="new-comment"]')?.textContent).toContain('更新后新增');
});
