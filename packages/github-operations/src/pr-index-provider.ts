import { awaitGitHubCaller } from './business/infrastructure/github/abortable-wait.js';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import type { PrIndexProvider } from './pr-provider-index.js';

/** Only bounded metadata crosses the provider boundary; no issue bodies or
 * task/principal authority enters the repository index. */
export class GitHubPrIndexProvider implements PrIndexProvider {
  constructor(private readonly options: { token(): Promise<string | undefined>; execFileAsync?: GitHubRequestOptions['execFileAsync'] }) {}
  private async query(url: string, jq: string, signal: AbortSignal): Promise<unknown[]> {
    const ghToken = await awaitGitHubCaller(this.options.token(), signal);
    const { stdout } = await executeGitHubRequest(['api', url, '--hostname', 'github.com', '--method', 'GET', '--jq', jq], {
      ghToken, signal, ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}),
    });
    signal.throwIfAborted();
    if (Buffer.byteLength(stdout) > 256 * 1024) throw new TypeError('PR metadata response exceeds bound');
    return stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
  }
  page(repo: string, page: number, signal: AbortSignal) {
    return this.query(`https://api.github.com/repos/${repo}/pulls?state=all&sort=created&direction=asc&per_page=25&page=${page}`,
      '.[] | {number,title,state,merged_at,user:.user.login,head_sha:.head.sha,draft,updated_at}', signal);
  }
  async reviewPage(repo: string, number: number, page: number, signal: AbortSignal) {
    const rows = await this.query(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`,
      '.[] | {user:.user.login,state,commit_id}', signal);
    if (rows.length > 100) throw new TypeError('oversized PR review page');
    return rows;
  }
}
