import { KILL_GRACE_MS } from './gh-process.js';

// Cancellation retains ownership until TERM→KILL cleanup has completed.
const SETTLE_MS = KILL_GRACE_MS + 500;
/** Package-local poll budget; this is not a Host action or caller protocol. */
interface PollBudget { readonly signal?: AbortSignal; readonly deadlineMs?: number; readonly now?: () => number; readonly objectTimeoutMs?: number }

/** Internal plugin policy. Progress tracks admission fairness, never provider
 * observation success; cursors for comments/events remain separate. */
export interface GitHubPollOptions {
  readonly now?: () => number;
  readonly pollBudgetMs?: number;
  readonly objectTimeoutMs?: number;
  readonly readProgress?: () => Promise<string | undefined>;
  readonly writeProgress?: (key: string) => Promise<void>;
}

export function gitHubPollBudget(signal: AbortSignal, options: GitHubPollOptions): PollBudget {
  const now = options.now ?? Date.now;
  const budgetMs = options.pollBudgetMs ?? 25_000;
  const objectTimeoutMs = options.objectTimeoutMs ?? 10_000;
  if (![budgetMs, objectTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('GitHub polling budgets must be positive integer milliseconds');
  }
  return { signal, now, deadlineMs: now() + budgetMs, objectTimeoutMs };
}

/** Reserve room to return already collected durable work before the whole-gate
 * deadline. A slow remote object may fail independently of other ready items. */
export function gitHubAdmissionCanContinue(ctx: PollBudget | undefined): boolean {
  return ctx?.deadlineMs === undefined || (ctx.now ?? Date.now)() + SETTLE_MS < ctx.deadlineMs;
}

export function gitHubObjectSignal(ctx: PollBudget | undefined): AbortSignal | undefined {
  if (!ctx?.signal) return undefined;
  const timeout = ctx.objectTimeoutMs ?? 10_000;
  const remaining = ctx.deadlineMs === undefined ? timeout : Math.max(1, ctx.deadlineMs - (ctx.now ?? Date.now)() - SETTLE_MS);
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(timeout, remaining))]);
}

/** Abort requests cancellation; completion still awaits the provider's actual
 * cleanup. A provider returning after cancellation cannot commit a baseline. */
export async function readGitHubObject<T>(ctx: PollBudget, read: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const signal = gitHubObjectSignal(ctx);
  signal?.throwIfAborted();
  const result = await read(signal);
  signal?.throwIfAborted();
  return result;
}
