import { act } from 'react';
import { createRoot } from '../ui-root';
import { expect, it, vi } from 'vitest';
import { IssueWorkbenchPreview } from '../../src/ui/IssueWorkbenchPreview';
import { STORAGE_KEY } from '../../src/ui/workbench-model';

const version = 'a'.repeat(64);
const detail = {
  number: 42,
  title: 'Selected issue',
  state: 'OPEN',
  labels: [],
  url: 'https://github.com/zts212653/clowder-ai/issues/42',
  updatedAt: new Date().toISOString(),
  fetchedAt: new Date().toISOString(),
  detailVersion: version,
  body: 'Archived original',
  commentCount: 55,
  comments: Array.from({ length: 25 }, (_, i) => ({
    id: String(i),
    author: 'author',
    body: `comment ${i}`,
    url: 'https://github.com',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEditedAt: null,
  })),
};
it('loads only selected detail, pages pinned version and saves recoverable reference', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const { body, comments, ...index } = detail;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/issues/42'))
        return new Response(
          JSON.stringify({
            detail:
              url.includes('offset=25') || url.includes('offset=50')
                ? {
                    ...detail,
                    comments: Array.from({ length: url.includes('offset=50') ? 5 : 25 }, (_, i) => ({
                      ...detail.comments[0],
                      id: String(i + (url.includes('offset=50') ? 50 : 25)),
                      body: `comment ${i + (url.includes('offset=50') ? 50 : 25)}`,
                    })),
                  }
                : detail,
            failures: [],
          }),
        );
      return new Response(
        JSON.stringify({
          snapshot: {
            repo: 'zts212653/clowder-ai',
            revision: 1,
            fetchedAt: detail.fetchedAt,
            lastCompleteAt: detail.fetchedAt,
            issues: [index, { ...index, number: 43, title: 'Other issue' }],
            failures: [],
            summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
          },
        }),
      );
    }),
  );
  const button = (text: string) => [...node.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<IssueWorkbenchPreview />));
    expect(node.textContent).toContain('Archived original');
    expect(calls.some((u) => u.includes('/issues/43'))).toBe(false);
    expect(node.textContent).toContain('25 / 55');
    await act(async () => button('加载更多评论').click());
    expect(node.textContent).toContain('comment 49');
    expect(node.textContent).not.toContain('来源有更新');
    expect(calls.some((u) => u.includes(`version=${version}&offset=25`))).toBe(true);
    await act(async () => button('加载全部评论').click());
    expect(node.textContent).toContain('comment 54');
    expect(node.textContent).toContain('55 / 55');
    await act(async () => button('解决方案').click());
    const input = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="解决方案"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'saved plan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('保存方案').click());
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).records['42'].solutionArchive).toBe(version);
    const archive = node.querySelector('details')!;
    await act(async () => {
      archive.open = true;
      archive.dispatchEvent(new Event('toggle'));
    });
    expect(archive.textContent).toContain('Archived original');
    expect(calls.some((u) => u.includes(`version=${version}&offset=0`))).toBe(true);
  } finally {
    act(() => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it('uncached offline detail is explicitly unavailable and cannot become a saved source basis', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const node = document.createElement('div');
  const root = createRoot(node);
  const { body, comments, ...index } = detail;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/issues/42/refresh')) throw new Error('offline');
      if (url.includes('/issues/42')) return new Response(JSON.stringify({ detail: null, failures: [] }));
      return new Response(
        JSON.stringify({
          snapshot: {
            repo: 'zts212653/clowder-ai',
            revision: 1,
            fetchedAt: detail.fetchedAt,
            lastCompleteAt: detail.fetchedAt,
            issues: [index],
            failures: [],
            summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
          },
        }),
      );
    }),
  );
  try {
    await act(async () => root.render(<IssueWorkbenchPreview />));
    expect(node.textContent).toContain('此问题内容尚未下载');
    expect(node.textContent).not.toContain('暂无 GitHub 评论');
    const buttons = () => [...node.querySelectorAll('button')];
    await act(async () =>
      buttons()
        .find((b) => b.textContent === '解决方案')!
        .click(),
    );
    expect(buttons().find((b) => b.textContent === '保存方案')!.disabled).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
