import { z } from 'zod';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { awaitGitHubCaller } from './business/infrastructure/github/abortable-wait.js';
import type { GhIssueFull } from './business/domains/community/github/GitHubIssueFetcher.js';
import type { GhPrFull, GhPrReview } from './business/domains/community/github/GitHubPrFetcher.js';

const number = z.number().int().positive().safe();
const text = z.string().min(1);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const issue = z.object({ number, title: text.max(1024), state: z.enum(['open', 'closed']), labels: z.array(z.string().max(100)).max(100),
  comments: z.number().int().nonnegative().safe(), user: text.max(100), html_url: z.string().url(), isPullRequest: z.boolean() });
const pr = z.object({ number, title: text.max(1024), state: z.enum(['open', 'closed']), merged_at: z.string().datetime().nullable(),
  user: text.max(100), head_sha: sha, draft: z.boolean(), labels: z.array(z.string().max(100)).max(100), updated_at: z.string().datetime() });
const review = z.object({ user: text.max(100), state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']), commit_id: sha, submitted_at: z.string().datetime() });

export interface CommunityRouteProviderOptions {
  readonly token: () => Promise<string | undefined>;
  readonly execFileAsync?: GitHubRequestOptions['execFileAsync'];
  readonly allowed: (repo: string) => Promise<boolean>;
  readonly assertCurrent: () => Promise<void>;
}

/** Read-only adapters for migrated HTTP sync routes. They return observations,
 * never review completion evidence. All pages must succeed before any result
 * is exposed; installed repository policy is rechecked after provider IO. */
export class CommunityRouteProvider {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: CommunityRouteProviderOptions) {}
  private repo(value: string): string {
    if (typeof value !== 'string' || value.length > 255 || value.trim() !== value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new TypeError('Invalid repository');
    return value.toLowerCase();
  }
  private async current(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await awaitGitHubCaller(this.options.assertCurrent(), signal); signal.throwIfAborted();
  }
  private run<T>(repository: string, path: string, jq: string, decode: (row: unknown, repo: string) => T | null, single = false): Promise<T[]> {
    const pending = this.read(repository, path, jq, decode, single);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async read<T>(repository: string, path: string, jq: string, decode: (row: unknown, repo: string) => T | null, single = false): Promise<T[]> {
    const repo = this.repo(repository), signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]);
    await this.current(signal);
    if (!await awaitGitHubCaller(this.options.allowed(repo), signal)) throw new Error('Repository is not configured for Community operations');
    await this.current(signal);
    const ghToken = await awaitGitHubCaller(this.options.token(), signal);
    await this.current(signal);
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = single ? '' : `${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
      const { stdout } = await executeGitHubRequest(['api', `https://api.github.com/repos/${repo}/${path}${query}`, '--hostname', 'github.com', '--method', 'GET', '--jq', jq], {
        ghToken, signal, ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}),
      });
      await this.current(signal);
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error('Community provider page exceeds limit');
      const rows: unknown[] = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
      if (single && rows.length !== 1) throw new Error('Expected one Community provider object');
      if (rows.length > 100) throw new Error('Community provider page exceeds row limit');
      for (const row of rows) { const item = decode(row, repo); if (item !== null) all.push(item); }
      // Revoke continuation as well as results when policy changes during any page.
      if (!await awaitGitHubCaller(this.options.allowed(repo), signal)) throw new Error('Repository policy changed during Community read');
      await this.current(signal);
      // Filtering PRs/pending reviews must not truncate a full provider page.
      if (rows.length < 100) return all;
    }
    throw new Error('Community synchronization exceeds page limit; no partial result committed');
  }
  fetchIssues(repo: string): Promise<GhIssueFull[]> {
    return this.run(repo, 'issues?state=all&sort=created&direction=asc', '.[] | {number,title,state,labels:[.labels[].name],comments,user:.user.login,html_url,isPullRequest:(.pull_request != null)}', (row, repository) => {
      const value = issue.parse(row), url = new URL(value.html_url);
      if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || url.pathname.toLowerCase() !== `/${repository}/${value.isPullRequest ? 'pull' : 'issues'}/${value.number}`) throw new Error('Community issue parent mismatch');
      const { isPullRequest, ...result } = value; return isPullRequest ? null : result;
    });
  }
  fetchPrs(repo: string): Promise<GhPrFull[]> {
    return this.run(repo, 'pulls?state=all&sort=created&direction=asc', '.[] | {number,title,state,merged_at,user:.user.login,head_sha:.head.sha,draft,labels:[.labels[].name],updated_at}', row => pr.parse(row));
  }
  fetchPrReviews(repo: string, prNumber: number): Promise<GhPrReview[]> {
    number.parse(prNumber);
    return this.run(repo, `pulls/${prNumber}/reviews`, '.[] | {user:.user.login,state,commit_id,submitted_at}', row => {
      if (row && typeof row === 'object' && 'state' in row && row.state === 'PENDING') return null;
      const { submitted_at: _submitted, ...value } = review.parse(row); return value;
    });
  }
  async verifyPublicIssueComment(input: { repo: string; issueNumber: number; url: string }): Promise<boolean> {
    const repo = this.repo(input.repo); number.parse(input.issueNumber);
    let url: URL;
    try { url = new URL(input.url); } catch { return false; }
    const match = /^#issuecomment-([1-9][0-9]*)$/.exec(url.hash);
    if (!match || url.origin !== 'https://github.com' || url.username || url.password || url.search || url.pathname.toLowerCase() !== `/${repo}/issues/${input.issueNumber}`) return false;
    const id = number.parse(Number(match[1]));
    const result = await this.run(repo, `issues/comments/${id}`, '.', row => {
      const value = z.object({ id: number, html_url: z.string().url(), issue_url: z.string().url(), body: z.string() }).parse(row);
      return value.id === id && value.html_url.toLowerCase() === input.url.toLowerCase() &&
        value.issue_url.toLowerCase() === `https://api.github.com/repos/${repo}/issues/${input.issueNumber}` && value.body.trim().length > 0;
    }, true);
    return result[0] === true;
  }
  async fetchIssueCommentCursor(repo: string, issueNumber: number): Promise<number> {
    number.parse(issueNumber);
    const rows = await this.run(repo, `issues/${issueNumber}/comments`, '.[] | {id}', row => z.object({ id: number }).parse(row).id);
    return rows.reduce((max, id) => Math.max(max, id), 0);
  }
  async stop(): Promise<void> { this.lifetime.abort(); await Promise.allSettled(this.pending); }
}
