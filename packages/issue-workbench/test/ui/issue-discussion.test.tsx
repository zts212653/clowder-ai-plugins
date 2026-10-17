import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from '../ui-root';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueDetail } from '../../src/ui/IssueDetail';
import { sanitizeIssueHtml } from '../../src/ui/IssueDiscussion';
import { emptyWork } from '../../src/ui/workbench-model';

const fact = {
  number: 42,
  title: '完整问题',
  url: 'https://github.com/example/repo/issues/42',
  state: 'OPEN',
  labels: ['bug'],
  updatedAt: '2026-10-10T07:00:00Z',
  createdAt: '2026-10-01T07:00:00Z',
  author: 'reporter',
  body: '## 复现步骤\n\n正文末尾证据\n\n```js\nconst result = 42;\n```\n\n[不安全](javascript:alert(1))\n\n<script>alert(1)</script>',
  bodyHTML:
    '<h2>复现步骤</h2><p>正文末尾证据</p><pre><code>const result = 42;</code></pre><a href="javascript:alert(1)">不安全</a><script>alert(1)</script>',
  commentCount: 2,
  comments: [
    {
      id: 'one',
      author: 'maintainer',
      body: '请提供版本',
      createdAt: '2026-10-02T07:00:00Z',
      updatedAt: '2026-10-02T07:00:00Z',
      lastEditedAt: null,
      url: 'https://github.com/example/repo/issues/42#issuecomment-1',
    },
    {
      id: 'two',
      author: 'reporter',
      body: '完整回复最后一行',
      createdAt: '2026-10-03T07:00:00Z',
      updatedAt: '2026-10-04T07:00:00Z',
      lastEditedAt: '2026-10-04T07:00:00Z',
      url: 'https://github.com/example/repo/issues/42#issuecomment-2',
    },
  ],
};

describe('read the GitHub issue before writing a local solution', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(value = fact) {
    await act(async () =>
      root.render(
        <IssueDetail fact={value} work={emptyWork()} onSave={vi.fn()} onBack={vi.fn()} onDirtyChange={vi.fn()} />,
      ),
    );
  }
  it('defaults to the full body and chronological comments with attribution; renders untrusted Markdown safely', async () => {
    await render({ ...fact, bodyHTML: undefined as unknown as string });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('问题与讨论');
    expect(container.textContent).toContain('正文末尾证据');
    expect(container.querySelector('pre code')?.textContent).toContain('const result = 42;');
    expect(container.textContent).toContain('完整回复最后一行');
    const comments = [...container.querySelectorAll('[data-comment-id]')];
    expect(comments.map((x) => x.getAttribute('data-comment-id'))).toEqual(['one', 'two']);
    expect(comments[0].textContent).toContain('maintainer');
    expect(comments[1].textContent).toContain('已编辑');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
  it('distinguishes a fetched empty conversation from missing data', async () => {
    await render({ ...fact, body: '', comments: [], commentCount: 0 });
    expect(container.textContent).toContain('作者未填写正文');
    expect(container.textContent).toContain('暂无 GitHub 评论');
  });
  it('keeps GitHub details and screenshots while removing active content and unsafe resource URLs', () => {
    const html = sanitizeIssueHtml(
      '<details open><summary>截图</summary><img src="https://example.com/image.png" onerror="alert(1)"></details><iframe src="https://example.com"></iframe><input type="text"><input type="checkbox" checked><video autoplay src="file:///secret"></video><a href="https://github.com/example/repo">源链接</a>',
      fact.url,
    );
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(holder.querySelector('summary')?.textContent).toBe('截图');
    expect(holder.querySelector('img')?.src).toBe('https://example.com/image.png');
    expect(holder.querySelector('[onerror], iframe, [autoplay], [src^="file:"], input[type="text"]')).toBeNull();
    expect(holder.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(holder.querySelector('a')?.rel).toBe('noopener noreferrer');
  });
  it('reports incomplete comments instead of declaring them complete or empty', async () => {
    await render({ ...fact, comments: [fact.comments[0]] });
    expect(container.textContent).toContain('评论数据尚未完整载入');
    expect(container.textContent).not.toContain('已载入此快照全部可见评论');
    expect(container.textContent).not.toContain('暂无 GitHub 评论');
  });
  it('keeps an unsaved solution when switching between reading and writing', async () => {
    await render();
    const tab = (name: string) => {
      const element = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((x) =>
        x.textContent?.includes(name),
      );
      if (!element) throw new Error(`Missing tab: ${name}`);
      return element;
    };
    await act(async () => tab('解决方案').click());
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="解决方案"]');
    if (!input) throw new Error('Missing solution input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '尚未保存的方案');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => tab('问题与讨论').click());
    await act(async () => tab('解决方案').click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="解决方案"]')?.value).toBe(
      '尚未保存的方案',
    );
  });
});
