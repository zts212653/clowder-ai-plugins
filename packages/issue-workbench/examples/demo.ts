// Demo imports the packed browser entry; it never imports Core or a source checkout.
import { mountWorkbench, type ConfirmOptions } from './browser.js';
const repo = 'example/issues';
const now = new Date().toISOString();
const comments = Array.from({ length: 37 }, (_, i) => ({ id: String(i), author: 'contributor', body: '合成讨论 ' + (i+1), createdAt: now, updatedAt: now, lastEditedAt: null, url: 'https://github.com/example/issues/issues/1' }));
let fact = { number: 1, title: '改善离线阅读体验', state: 'OPEN', labels: ['enhancement'], url: 'https://github.com/example/issues/issues/1', updatedAt: now, fetchedAt: now,
  body: '## 阅读与验证\n这是合成问题正文。可以试试评论分页、保存方案和刷新恢复。', comments, commentCount: comments.length, detailVersion: 'a'.repeat(64), reviewVersion: 'first' };
const versions = new Map([[fact.detailVersion, fact]]);
let revision = 1;
async function request(path: string) {
  const url = new URL(path, 'http://example.invalid');
  if (url.pathname.includes('/issues/')) {
    if (url.pathname.endsWith('/refresh')) {
      fact = { ...fact, fetchedAt: new Date().toISOString() }; versions.set(fact.detailVersion, fact);
    }
    const detail = versions.get(url.searchParams.get('version') ?? fact.detailVersion);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return Response.json({ detail: detail ? { ...detail, comments: detail.comments.slice(offset,offset+25) } : null, failures: [] });
  }
  if (url.pathname.endsWith('/refresh')) revision++;
  const { body, comments: _comments, ...index } = fact;
  return Response.json({ snapshot: { repo, revision, fetchedAt: now, lastCompleteAt: new Date().toISOString(), issues: [index], failures: [], summary: { added: 0, changed: 0, closed: 0, reopened: 0 } } });
}
function confirm(options: ConfirmOptions): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>('#confirm')!;
  dialog.querySelector('h2')!.textContent = options.title;
  dialog.querySelector('p')!.textContent = options.message;
  const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
  const accept = document.querySelector<HTMLButtonElement>('#accept')!;
  cancel.textContent = options.cancelLabel ?? '取消'; accept.textContent = options.confirmLabel ?? '确认';
  return new Promise(resolve => {
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; dialog.close(); resolve(value); };
    cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
    dialog.oncancel = event => { event.preventDefault(); finish(false); }; dialog.showModal(); cancel.focus();
  });
}
mountWorkbench(document.querySelector<HTMLElement>('#app')!, { repo, dataScope: 'synthetic-demo', storage: localStorage, request, confirm });
