import { fetchPaginated } from './business/infrastructure/github/fetch-paginated.js';
import { createGitHubRepoPollReaders } from './business/infrastructure/github/repo-poll-readers.js';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { fetchPrCiStatus, enrichPrCiStatus, type FetchPrCiStatusOptions } from './business/infrastructure/email/ci-status-fetcher.js';
import { fetchPrCiStatuses, ciStatusTargetKey } from './business/infrastructure/email/ci-status-batch-fetcher.js';
import type { CiPollResult } from './business/infrastructure/email/ci-cd-contract.js';
import { classifyCiWaitBucket } from './business/infrastructure/email/CiCdRouter.js';
import { fetchGitHubReviewThreads } from './business/infrastructure/github/fetch-review-threads.js';
import type { GitHubComment, GitHubReview, GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';
import type { CommunityProvider, RepoSubject } from './community-runtime.js';
import type { RepoIssueComment } from './business/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import { publicationBody, type NativeIssueDraft, type NativeIssuePublisher, type PublishedIssue } from './native-issue-drafts.js';
import { observeReviewDelivery, observeReviewHead, type GitHubReviewSubject } from './github-review-evidence.js';

interface ApiComment {
  id: number; user: { login: string; type?: string }; body?: string;
  commit_id?: string; created_at?: string; author_association?: string;
  pull_request_review_id?: number;
}
interface ApiReview {
  id: number; user: { login: string; type?: string }; state: string;
  commit_id?: string; submitted_at?: string; author_association?: string;
}
function commentOf(value: ApiComment, commentType: GitHubComment['commentType']): GitHubComment {
  return { id: value.id, author: value.user.login, body: value.body ?? '', commentType,
    ...(value.commit_id ? { commitId: value.commit_id } : {}),
    ...(value.pull_request_review_id ? { reviewId: value.pull_request_review_id } : {}),
    ...(value.created_at ? { createdAt: value.created_at } : {}),
    ...(value.user.type ? { actorType: value.user.type } : {}),
    ...(value.author_association ? { authorAssociation: value.author_association } : {}),
  };
}

function ciOptions(options: GitHubRequestOptions): FetchPrCiStatusOptions {
  return { ghToken: options.ghToken, signal: options.signal,
    ...(options.execFileAsync ? { execFileAsync: (file, args, opts) => options.execFileAsync!(file, [...args], opts as Parameters<NonNullable<GitHubRequestOptions['execFileAsync']>>[2]) } : {}),
  };
}

/** Real gh JSON transport, retaining the migrated quota, pagination and child-close handling. */
export class GitHubProvider implements GitHubTrackingProvider, CommunityProvider, NativeIssuePublisher {
  private login: string | undefined;
  constructor(private readonly options: {
    token(): Promise<string | undefined>;
    log: { warn(message: string, fields?: Readonly<Record<string, unknown>>): void };
    execFileAsync?: GitHubRequestOptions['execFileAsync'];
  }) {}

  selfLogin(): string | undefined { return this.login; }

  async observeReviewHead(input: GitHubReviewSubject, signal: AbortSignal) {
    return observeReviewHead(input, await this.requestOptions(AbortSignal.any([signal, AbortSignal.timeout(30_000)])));
  }

  async observeReviewDelivery(input: GitHubReviewSubject & { readonly url: string }, signal: AbortSignal) {
    return observeReviewDelivery(input, await this.requestOptions(AbortSignal.any([signal, AbortSignal.timeout(30_000)])));
  }

  async create(draft: NativeIssueDraft, signal: AbortSignal): Promise<PublishedIssue> {
    const options = await this.requestOptions(signal);
    // One invocation, no POST retries. The caller durably records the attempt
    // before reaching this transport and reconciles ambiguous results by GET.
    const value = JSON.parse((await executeGitHubRequest(['api', `/repos/${draft.repo}/issues`, '--hostname', 'github.com', '--method', 'POST',
      '--raw-field', `title=${draft.title}`, '--raw-field', `body=${publicationBody(draft)}`, ...(draft.labels ?? []).flatMap(label => ['--raw-field', `labels[]=${label}`])], options)).stdout);
    return { number: value.number, url: value.html_url };
  }

  async verifyPublicIssueComment(input: { repo: string; issueNumber: number; url: string }): Promise<boolean> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) || !Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) return false;
    const url = new URL(input.url);
    const match = /^#issuecomment-([1-9][0-9]*)$/.exec(url.hash);
    if (!match || url.origin !== 'https://github.com' || url.username || url.password || url.search || url.pathname.toLowerCase() !== `/${input.repo}/issues/${input.issueNumber}`.toLowerCase()) return false;
    const options = await this.requestOptions(AbortSignal.timeout(30_000));
    const value = JSON.parse((await executeGitHubRequest(['api', `/repos/${input.repo}/issues/comments/${match[1]}`, '--hostname', 'github.com'], options)).stdout);
    return typeof value.html_url === 'string' && value.html_url.toLowerCase() === input.url.toLowerCase() &&
      typeof value.issue_url === 'string' && value.issue_url.toLowerCase() === `https://api.github.com/repos/${input.repo}/issues/${input.issueNumber}`.toLowerCase() &&
      String(value.id) === match[1] && typeof value.body === 'string' && value.body.trim().length > 0;
  }

  async find(draft: NativeIssueDraft, signal: AbortSignal): Promise<PublishedIssue | null> {
    const options = await this.requestOptions(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    const login = (await executeGitHubRequest(['api', 'user', '--hostname', 'github.com', '--jq', '.login'], options)).stdout.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) throw new Error('GitHub account unavailable for publication reconciliation');
    const issues = await fetchPaginated(`https://api.github.com/repos/${draft.repo}/issues?state=all&creator=${encodeURIComponent(login)}`, options);
    const matches = issues.filter(value => !value.pull_request && value.user?.login?.toLowerCase() === login.toLowerCase() &&
      value.title === draft.title && value.body === publicationBody(draft));
    if (matches.length > 1) throw new Error('multiple issues match the publication marker');
    return matches.length === 1 ? { number: matches[0].number, url: matches[0].html_url } : null;
  }

  async forCiBatch(targets: readonly GitHubTarget[], signal: AbortSignal): Promise<GitHubTrackingProvider> {
    const options = await this.requestOptions(signal);
    const results = await fetchPrCiStatuses(targets.filter(target => target.kind === 'pr').map(target => ({
      repoFullName: target.repoFullName, prNumber: target.number,
    })), { warn: () => this.options.log.warn('GitHub batch CI read incomplete; preserving unavailable baselines') }, ciOptions(options));
    // Scope the snapshot to this tick, never share mutable cached HEADs between
    // concurrent schedule channels or registrations.
    return { read: (target, signal, cursor) => this.read(target, signal, cursor,
      results.get(ciStatusTargetKey(target.repoFullName, target.number)) ?? null) };
  }

  private async requestOptions(signal: AbortSignal): Promise<GitHubRequestOptions> {
    signal.throwIfAborted();
    return { ghToken: await this.options.token(), signal, log: this.options.log,
      ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}) };
  }

  async listOpen(repo: string, signal: AbortSignal): Promise<RepoSubject[]> {
    const options = await this.requestOptions(signal);
    const subjects: RepoSubject[] = [];
    for (const kind of ['pr', 'issue'] as const) {
      const values = await fetchPaginated(`/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}?state=open`, options);
      for (const value of values) {
        if (kind === 'issue' && value.pull_request) continue;
        subjects.push({ kind, number: value.number, title: value.title, url: value.html_url,
          author: value.user.login, authorAssociation: value.author_association, draft: value.draft === true });
      }
    }
    return subjects;
  }

  async repoComments(repo: string, since: string | undefined, signal: AbortSignal): Promise<RepoIssueComment[]> {
    const options = await this.requestOptions(signal);
    this.login = (await executeGitHubRequest(['api', 'user', '--jq', '.login'], options)).stdout.trim() || undefined;
    // Reuse the migrated reader: each listing row already identifies its parent
    // and PR/issue kind. Per-parent lookups multiply the bounded poll's requests.
    return createGitHubRepoPollReaders({
      getGitHubToken: () => options.ghToken, execFileAsync: options.execFileAsync,
    }).fetchRepoComments(repo, since, signal);
  }

  async state(repo: string, kind: 'pr' | 'issue', number: number, signal: AbortSignal) {
    const options = await this.requestOptions(signal);
    const data = JSON.parse((await executeGitHubRequest(['api', `/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`], options)).stdout);
    return { state: data.state === 'closed' ? 'closed' as const : 'open' as const,
      closedAt: data.closed_at ?? null, mergedAt: data.merged_at ?? null };
  }

  async read(target: GitHubTarget, signal: AbortSignal, cursor?: { inline: number; conversation: number }, batchCi?: CiPollResult | null): Promise<GitHubSnapshot> {
    signal.throwIfAborted();
    const options: GitHubRequestOptions = {
      ghToken: await this.options.token(), signal, log: this.options.log,
      ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}),
    };
    const account = await executeGitHubRequest(['api', 'user', '--jq', '.login'], options);
    this.login = account.stdout.trim() || undefined;
    const selfLogin = this.login;
    const path = `/repos/${target.repoFullName}`;
    const metadata = JSON.parse((await executeGitHubRequest(
      ['api', `${path}/${target.kind === 'pr' ? 'pulls' : 'issues'}/${target.number}`], options,
    )).stdout) as { state: string; user?: { login: string }; merged_at?: string | null; merged_by?: { login: string } | null; mergeable_state?: string; head?: { sha: string };
      requested_reviewers?: { login: string }[]; base?: { repo?: { permissions?: { push?: boolean } } } };
    const complete = !!target.cloudReviewRequest || cursor === undefined;
    const conversation = await fetchPaginated(`${path}/issues/${target.number}/comments`, { ...options, sinceId: complete ? undefined : cursor?.conversation }) as ApiComment[];
    const comments: GitHubComment[] = conversation.map(c => commentOf(c, 'conversation'));
    const reviews: GitHubReview[] = [];
    let ci: GitHubSnapshot['ci'];
    let ciBlockerCount: number | undefined;
    let reviewThreads: GitHubSnapshot['reviewThreads'];
    if (target.kind === 'pr') {
      const inline = await fetchPaginated(`${path}/pulls/${target.number}/comments`, { ...options, sinceId: complete ? undefined : cursor?.inline }) as ApiComment[];
      comments.push(...inline.map(c => commentOf(c, 'inline')));
      const decisions = await fetchPaginated(`${path}/pulls/${target.number}/reviews`, options) as ApiReview[];
      reviews.push(...decisions.map(r => ({ id: r.id, author: r.user.login, state: r.state,
        ...(r.commit_id ? { commitId: r.commit_id } : {}),
        ...(r.submitted_at ? { submittedAt: r.submitted_at } : {}),
        ...(r.user.type ? { actorType: r.user.type } : {}),
        ...(r.author_association ? { authorAssociation: r.author_association } : {}),
      })));
      if (target.reviewThreadIds?.length) reviewThreads = await fetchGitHubReviewThreads(target.repoFullName, target.number, target.reviewThreadIds, options);
      // Batch admission contains only base facts. Failure details and incomplete
      // rollups use this PR's deadline and a freshly resolved configured token.
      const ciRequest = ciOptions(await this.requestOptions(signal));
      const ciLog = { warn: () => this.options.log.warn('GitHub CI read failed; preserving tracking baseline') };
      const status = batchCi == null
        ? await fetchPrCiStatus(target.repoFullName, target.number, ciLog, ciRequest)
        : await enrichPrCiStatus(batchCi, ciLog, ciRequest);
      if (!status) throw new Error('GitHub CI snapshot unavailable');
      if (status.headSha !== metadata.head?.sha) throw new Error('GitHub HEAD changed during snapshot; retry without advancing cursors');
      // Preserve CiCdRouter's empty-rollup rule: absence of checks is not a pass.
      ci = status.checkRollup === 'empty' ? 'pending' : classifyCiWaitBucket(status);
      ciBlockerCount = status.checks.filter(check => check.bucket === 'fail').length;
    }
    signal.throwIfAborted();
    const matchesSelf = (login: string) => !!selfLogin && login.toLowerCase() === selfLogin.toLowerCase();
    const reviewerGround = metadata.requested_reviewers?.some(reviewer => matchesSelf(reviewer.login)) ? 'review_requested'
      : reviews.some(review => matchesSelf(review.author)) ? 'review_submitted'
      : metadata.base?.repo?.permissions?.push === true ? 'repo_write_access' : undefined;
    return {
      trackingIdentity: { ...(selfLogin ? { selfLogin } : {}),
        ...(metadata.user?.login ? { subjectAuthorLogin: metadata.user.login } : {}),
        ...(reviewerGround ? { reviewerGround } : {}) },
      state: metadata.merged_at ? 'merged' : metadata.state === 'closed' ? 'closed' : 'open',
      ...(metadata.user?.login ? { authorLogin: metadata.user.login } : {}),
      ...(metadata.merged_by?.login ? { mergedByLogin: metadata.merged_by.login } : {}),
      ...(metadata.head ? { headSha: metadata.head.sha } : {}),
      ...(ci ? { ci } : {}),
      ...(ciBlockerCount !== undefined ? { ciBlockerCount } : {}),
      ...(target.kind === 'pr' ? { mergeState: (metadata.mergeable_state ?? 'unknown').toUpperCase() } : {}),
      comments, reviews, commentsComplete: complete, ...(reviewThreads ? { reviewThreads } : {}),
    };
  }
}
