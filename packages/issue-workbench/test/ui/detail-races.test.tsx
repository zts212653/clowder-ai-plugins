import { act } from 'react';
import { createRoot } from '../ui-root';
import { expect, it, vi } from 'vitest';
import { useIssueDetail } from '../../src/ui/useIssueDetail';

const fact = (number: number, body: string) => ({
  number,
  body,
  state: 'OPEN',
  title: `Issue ${number}`,
  labels: [],
  url: 'https://github.com',
  updatedAt: new Date().toISOString(),
  fetchedAt: new Date().toISOString(),
  comments: [],
  commentCount: 0,
  detailVersion: body,
});
const response = (detail: unknown) => new Response(JSON.stringify({ detail, failures: [] }));
it('a slow cached response cannot replace an explicit newer check or another selected issue', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveOld!: (r: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/1?') ? old : response(fact(url.includes('/2') ? 2 : 1, 'new source')),
    ),
  );
  const node = document.createElement('div');
  const root = createRoot(node);
  function View({ number }: { number: number }) {
    const source = useIssueDetail(number, true);
    return (
      <>
        <span>{source.detail?.body ?? 'not loaded'}</span>
        <button type="button" onClick={() => void source.refresh()}>refresh</button>
      </>
    );
  }
  try {
    await act(async () => root.render(<View number={1} />));
    await act(async () => node.querySelector('button')!.click());
    expect(node.textContent).toContain('new source');
    await act(async () => resolveOld(response(fact(1, 'old source'))));
    expect(node.textContent).not.toContain('old source');
    await act(async () => root.render(<View number={2} />));
    expect(node.textContent).toContain('new source');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
