import type { IssueSourceComment, IssueSourceFact, IssueSourceFailure, IssueSourceReadResult } from '../model/issue-source.js';
const commentFields = 'id author { login } body createdAt updatedAt lastEditedAt url';
const catalogFields = `id number title url state updatedAt createdAt author { login }
  assignees(first:100) { nodes { login } pageInfo { hasNextPage } }
  labels(first:100) { nodes { name } pageInfo { hasNextPage } }
  comments { totalCount }`;
const issueFields = `id number title url state updatedAt createdAt body author { login }
  assignees(first:100) { nodes { login } pageInfo { hasNextPage } }
  labels(first:100) { nodes { name } pageInfo { hasNextPage } }
  comments(first:100) { totalCount nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }`;
interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount?: number;
}
interface GhComment extends Omit<IssueSourceComment, 'author'> {
  author: { login: string } | null;
}
interface GhIssue extends Omit<IssueSourceFact, 'author' | 'labels' | 'comments' | 'assignees'> {
  author: { login: string } | null;
  labels: Connection<{ name: string }>;
  assignees?: Connection<{ login: string }>;
  comments: Connection<GhComment>;
}
interface GhData {
  repository?: { issues: Connection<GhIssue>; focus?: GhIssue | null } | null;
  node?: { comments: Connection<GhComment> } | null;
  rateLimit?: { remaining: number; resetAt: string };
}
export type GhQuery = (query: string, variables: Record<string, string>) => Promise<GhData>;
export function decodeGhSourceResponse(stdout: string): GhData {
  const result = JSON.parse(stdout);
  // GitHub may return readable inventory alongside an inaccessible focused issue.
  // Only this bounded nullable field is recoverable; all other GraphQL errors fail the page.
  const focusOnly =
    result.data?.repository?.issues &&
    result.errors?.every((e: { path?: unknown[] }) => e.path?.[0] === 'repository' && e.path?.[1] === 'focus');
  if (result.errors?.length && !focusOnly)
    throw new Error(result.errors.map((e: { type?: string; message?: string }) => `${e.type} ${e.message}`).join(' '));
  if (result.errors?.length && focusOnly) result.data.repository.focus = null;
  if (!result.data) throw new Error('GraphQL source read incomplete');
  return result.data;
}
export function failure(error: unknown, issueNumber?: number): IssueSourceFailure {
  // Never return raw CLI stderr: it may contain command arguments or credential diagnostics.
  const message = String((error as { stderr?: string })?.stderr ?? (error as Error)?.message ?? '');
  const kind = /rate limit|RATE_LIMITED/i.test(message)
    ? 'rate_limit'
    : /401|authentication|login|credentials/i.test(message)
      ? 'auth'
      : /404|not found|Could not resolve/i.test(message)
        ? 'unavailable'
        : /ENOTFOUND|ECONN|network|timeout|timed out|error connecting/i.test(message)
          ? 'network'
          : 'incomplete';
  return {
    issueNumber,
    kind,
    message:
      kind === 'auth'
        ? 'GitHub 登录已失效，请在账户设置恢复登录。'
        : kind === 'rate_limit'
          ? 'GitHub 限流，请在可重试时间后重试。'
          : kind === 'unavailable'
            ? '来源暂不可用，已保留上次内容。'
            : kind === 'network'
              ? '网络不可用或读取超时，已保留上次内容。'
              : 'GitHub 内容未完整读取，请重试。',
  };
}
/** Query-only adapter. Combined issue/comment pages avoid a request per unchanged issue. */
export function createGhIssueSourceReader(query: GhQuery) {
  return async (
    repo: string,
    since?: string,
    priorityNumber?: number,
    scope: 'catalog' | 'detail' | 'full' = 'full',
  ): Promise<IssueSourceReadResult> => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
    if (priorityNumber !== undefined && (!Number.isSafeInteger(priorityNumber) || priorityNumber < 1))
      throw new Error('Invalid issue number');
    const fields = scope === 'catalog' ? catalogFields : issueFields;
    const [owner, name] = repo.split('/');
    const issues: IssueSourceFact[] = [];
    const failures: IssueSourceFailure[] = [];
    let cursor: string | undefined;
    let resetAt: string | undefined;
    let remaining = 1;
    const seen = new Set<string>();
    const seenIssues = new Set<number>();
    try {
      do {
        const page = await query(
          `query($owner:String!,$name:String!${scope === 'detail' ? '' : ',$cursor:String'}) {
          repository(owner:$owner,name:$name) { ${priorityNumber && !cursor ? `focus:issue(number:${priorityNumber}) { ${fields} }` : ''}
          ${
            scope === 'detail'
              ? ''
              : `issues(first:50,after:$cursor,orderBy:{field:${since ? 'UPDATED_AT' : 'CREATED_AT'},direction:${since ? 'DESC' : 'ASC'}}) {
            nodes { ${fields} } pageInfo { hasNextPage endCursor }
          }`
          } } rateLimit { remaining resetAt } }`,
          { owner, name, ...(cursor ? { cursor } : {}) },
        );
        if (scope === 'detail' && page.repository)
          page.repository.issues = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        if (!page.repository?.issues) throw new Error('Could not resolve repository');
        remaining = page.rateLimit?.remaining ?? 1;
        resetAt = page.rateLimit?.resetAt;
        const connection = page.repository.issues as Connection<GhIssue>;
        let reachedBaseline = false;
        const focus = page.repository.focus;
        if (priorityNumber && !cursor && !focus)
          failures.push({
            issueNumber: priorityNumber,
            kind: 'unavailable',
            message: '来源暂不可用，已保留上次内容。',
          });
        for (const raw of [...(focus ? [focus] : []), ...connection.nodes]) {
          if (since && raw.updatedAt < since && raw.number !== priorityNumber) {
            reachedBaseline = true;
            continue;
          }
          if (seenIssues.has(raw.number)) continue;
          seenIssues.add(raw.number);
          try {
            if (raw.labels.pageInfo.hasNextPage) throw new Error('labels incomplete');
            if (raw.assignees?.pageInfo.hasNextPage) throw new Error('assignees incomplete');
            const assignees = raw.assignees?.nodes.map(member => member.login);
            if (scope === 'catalog') {
              const { author, labels, comments, body: _body, bodyHTML: _html, ...index } = raw;
              issues.push({
                ...index,
                assignees,
                author: author?.login ?? '已注销用户',
                labels: labels.nodes.map((l) => l.name).sort(),
                commentCount: comments.totalCount,
              });
              continue;
            }
            const comments = [...raw.comments.nodes];
            let next = raw.comments.pageInfo;
            const cursors = new Set<string>();
            while (next.hasNextPage) {
              if (!next.endCursor || cursors.has(next.endCursor)) throw new Error('comments pagination incomplete');
              cursors.add(next.endCursor);
              const extra = await query(
                `query($id:ID!,$cursor:String!) { node(id:$id) { ... on Issue { comments(first:100,after:$cursor) {nodes {${commentFields}} pageInfo {hasNextPage endCursor}} } } }`,
                { id: raw.id!, cursor: next.endCursor },
              );
              const part = extra.node?.comments as Connection<GhComment> | undefined;
              if (!part) throw new Error('comments incomplete');
              comments.push(...part.nodes);
              next = part.pageInfo;
            }
            const unique = [...new Map(comments.map((c) => [c.id, c])).values()];
            if (unique.length !== raw.comments.totalCount) throw new Error('comments changed while reading');
            const { author, labels, comments: _, ...fact } = raw;
            issues.push({
              ...fact,
              assignees,
              author: author?.login ?? '已注销用户',
              labels: labels.nodes.map((l) => l.name).sort(),
              commentCount: raw.comments.totalCount,
              comments: unique.map((c) => ({ ...c, author: c.author?.login ?? '已注销用户' })),
            });
          } catch (error) {
            const problem = failure(error, raw.number);
            if (problem.kind === 'rate_limit' || problem.kind === 'auth') throw error;
            failures.push(problem);
          }
        }
        if (reachedBaseline || !connection.pageInfo.hasNextPage) break;
        const next = connection.pageInfo.endCursor;
        if (!next || seen.has(next)) throw new Error('issue pagination incomplete');
        if (remaining < 1) throw new Error('rate limit');
        seen.add(next);
        cursor = next;
      } while (cursor);
    } catch (error) {
      failures.push(failure(error));
    }
    const rateLimited = failures.some((f) => f.kind === 'rate_limit');
    return {
      issues,
      failures,
      complete: failures.length === 0,
      ...(rateLimited ? { retryAt: resetAt ?? new Date(Date.now() + 60_000).toISOString() } : {}),
    };
  };
}
