export { useSourceClient } from '../ports/context';
export const refreshRequest = { method: 'POST', headers: { 'x-issue-source-request': 'refresh' } };

/** Every page is read from the pinned archive, including when the live issue changes. */
export async function loadDiscussionPages(
  fact: import('./workbench-model').IssueFact,
  load: (version: string, offset?: number) => Promise<import('./workbench-model').IssueFact>,
  apply: (fact: import('./workbench-model').IssueFact) => void,
  all = false,
) {
  if (!fact.detailVersion) return;
  let next = fact;
  do {
    const offset = next.comments?.length ?? 0;
    const page = await load(fact.detailVersion, offset);
    if (page.detailVersion !== fact.detailVersion || !page.comments?.length) throw new Error('Incomplete archive page');
    next = { ...next, comments: [...(next.comments ?? []), ...page.comments] };
    apply(next);
  } while (all && (next.comments?.length ?? 0) < (next.commentCount ?? 0));
}
