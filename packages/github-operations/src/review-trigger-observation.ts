import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { awaitGitHubCaller } from './business/infrastructure/github/abortable-wait.js';

export interface ReviewTriggerInput { repoFullName: string; prNumber: number; triggerCommentId: number }
type UncoveredReason = 'subject_mismatch' | 'not_review_trigger' | 'review_not_accepted' | 'feedback_already_posted';
export type ReviewTriggerObservation =
  | { covered: true; triggerCommentId: number; observedAt: number }
  | { covered: false; reason: UncoveredReason; triggerCommentId: number; observedAt: number };

interface Options {
  token(): Promise<string | undefined>;
  execFileAsync?: GitHubRequestOptions['execFileAsync'];
  now?: () => number;
  /** Internal test clock budget; never read from invocation input. */
  timeoutMs?: number;
}
const BOT = 'chatgpt-codex-connector[bot]';
const MAX_PAGES = 100;

function request(value: unknown): ReviewTriggerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid review trigger input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['repoFullName', 'prNumber', 'triggerCommentId'].includes(key)) ||
    typeof v.repoFullName !== 'string' || v.repoFullName.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v.repoFullName) ||
    !Number.isSafeInteger(v.prNumber) || (v.prNumber as number) <= 0 ||
    !Number.isSafeInteger(v.triggerCommentId) || (v.triggerCommentId as number) <= 0) {
    throw new TypeError('invalid review trigger input');
  }
  return v as unknown as ReviewTriggerInput;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid GitHub evidence row');
  return value as Record<string, unknown>;
}
function isBot(value: unknown): boolean {
  const user = object(value);
  return typeof user.login === 'string' && user.login.toLowerCase() === BOT && user.type === 'Bot';
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('invalid GitHub evidence timestamp');
  return Date.parse(value);
}

/** Provider observation only. Host purpose trust, activation fences and admission
 * are intentionally absent: returning covered never grants a wait or verdict. */
export class ReviewTriggerReader {
  private readonly lifecycle = new AbortController();
  private readonly pending = new Set<Promise<ReviewTriggerObservation>>();
  constructor(private readonly options: Options) {}

  async observe(value: unknown): Promise<ReviewTriggerObservation> {
    const input = request(value);
    if (this.lifecycle.signal.aborted) throw new Error('review trigger reader stopped');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('review trigger query timed out')), this.options.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([this.lifecycle.signal, deadline.signal]);
    const pending = this.read(input, signal);
    this.pending.add(pending);
    try { return await pending; }
    finally { clearTimeout(timer); this.pending.delete(pending); }
  }

  async stop(): Promise<void> {
    this.lifecycle.abort(new Error('review trigger reader stopped'));
    await Promise.allSettled([...this.pending]);
  }

  private async read(input: ReviewTriggerInput, signal: AbortSignal): Promise<ReviewTriggerObservation> {
    const observedAt = (this.options.now ?? Date.now)();
    if (!Number.isFinite(observedAt) || observedAt < 0) throw new TypeError('invalid observation time');
    const options = { ghToken: await awaitGitHubCaller(this.options.token(), signal), signal, execFileAsync: this.options.execFileAsync };
    signal.throwIfAborted();
    const path = `https://api.github.com/repos/${input.repoFullName}`;
    const read = async (url: string, rows = false) => {
      const result = await executeGitHubRequest(['api', url, '--hostname', 'github.com', '--jq', rows ? '.[]' : '{id,body,issue_url,created_at}'], options);
      signal.throwIfAborted();
      return result.stdout;
    };
    const uncovered = (reason: UncoveredReason): ReviewTriggerObservation => ({ covered: false, reason, triggerCommentId: input.triggerCommentId, observedAt });
    const comment = object(JSON.parse(await read(`${path}/issues/comments/${input.triggerCommentId}`)));
    let matches = false;
    if (typeof comment.issue_url === 'string') {
      try {
        const url = new URL(comment.issue_url);
        matches = url.origin === 'https://api.github.com' && !url.username && !url.password &&
          url.pathname.toLowerCase() === `/repos/${input.repoFullName.toLowerCase()}/issues/${input.prNumber}`;
      } catch { /* malformed provider subject is uncovered */ }
    }
    if (comment.id !== input.triggerCommentId || !matches) return uncovered('subject_mismatch');
    if (typeof comment.body !== 'string' || !/^@codex\s+review(?:\s|$)/i.test(comment.body.trimStart())) return uncovered('not_review_trigger');
    const createdAt = timestamp(comment.created_at);

    // Fold bounded pages instead of buffering the entire history. Even after a
    // match, finish pagination: incomplete evidence must never report covered.
    const anyRow = async (endpoint: string, predicate: (row: Record<string, unknown>) => boolean) => {
      let found = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const stdout = await read(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, true);
        const rows = stdout.trim() ? stdout.trim().split('\n').map(line => object(JSON.parse(line))) : [];
        if (rows.length > 100) throw new Error('GitHub evidence page exceeds limit');
        for (const row of rows) if (predicate(row)) found = true;
        if (rows.length < 100) return found;
      }
      throw new Error('GitHub evidence pagination limit exceeded');
    };
    const accepted = await anyRow(`${path}/issues/comments/${input.triggerCommentId}/reactions?content=eyes`,
      row => row.content === 'eyes' && isBot(row.user));
    if (!accepted) return uncovered('review_not_accepted');
    let feedback = false;
    for (const endpoint of [`pulls/${input.prNumber}/reviews`, `pulls/${input.prNumber}/comments`, `issues/${input.prNumber}/comments`]) {
      const found = await anyRow(`${path}/${endpoint}`, row => isBot(row.user) && timestamp(row.submitted_at ?? row.created_at) >= createdAt);
      feedback = found || feedback;
    }
    signal.throwIfAborted();
    return feedback ? uncovered('feedback_already_posted') : { covered: true, triggerCommentId: input.triggerCommentId, observedAt };
  }
}
