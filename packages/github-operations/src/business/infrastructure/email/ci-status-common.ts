import { executeGitHubRequest } from '../github/request-budget.js';
import type { CiBucket } from './ci-cd-contract.js';

export type GhExecFileAsync = (file: string, args: readonly string[], options: unknown) => Promise<{ stdout: string }>;

export interface FetchPrCiStatusOptions {
  readonly ghToken?: string;
  /** Scheduler cancellation for every gh process in this poll generation. */
  readonly signal?: AbortSignal;
  /** Test seam at the real gh JSON boundary; production always uses node:child_process. */
  readonly execFileAsync?: GhExecFileAsync;
}

export async function executeGh(args: readonly string[], options: FetchPrCiStatusOptions): Promise<{ stdout: string }> {
  return executeGitHubRequest([...args], options);
}

export function normalizePrState(state: string, mergedAt: string | null): 'open' | 'merged' | 'closed' {
  if (mergedAt || state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

export function normalizeBucket(bucket: string): CiBucket {
  const lower = bucket.toLowerCase();
  if (lower === 'pass' || lower === 'success') return 'pass';
  if (lower === 'fail' || lower === 'failure' || lower === 'error') return 'fail';
  return 'pending';
}

export function computeAggregateBucket(
  rollup: Array<{ status: string; conclusion: string; __typename: string }>,
): CiBucket {
  // An empty rollup is ambiguous: GitHub may not have created the check runs yet
  // for a fresh HEAD, or the repository may define no checks. Neither is positive
  // CI evidence, so the router keeps this pending across later polls too.
  if (rollup.length === 0) return 'pending';
  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false; // at least one REAL positive result (success/skipped/neutral)
  for (const item of rollup) {
    if (item.__typename === 'StatusContext') {
      const state = item.status?.toLowerCase();
      if (state === 'failure' || state === 'error') hasFailure = true;
      else if (state === 'success') hasSuccess = true;
      else hasPending = true; // pending / expected
    } else {
      const conclusion = item.conclusion?.toLowerCase();
      // 'cancelled' is a superseded/aborted NON-result: GitHub auto-cancels in-progress runs when a
      // newer commit is pushed. It is neither a failure (so it can't fire a false CI-fail) nor a
      // success — GitHub's success states are success/skipped/neutral, NOT cancelled. So a PR needs
      // at least one REAL positive result to be 'pass': [cancelled + passing-re-run] → pass, but
      // [cancelled only] → pending (never a false green light for a waiting merge-gate).
      if (conclusion === 'failure' || conclusion === 'timed_out') hasFailure = true;
      else if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') hasSuccess = true;
      else if (conclusion !== 'cancelled') hasPending = true; // in-progress / no conclusion / unknown
    }
  }
  if (hasFailure) return 'fail';
  if (hasPending) return 'pending';
  return hasSuccess ? 'pass' : 'pending'; // only cancelled / no positive result → not a green light
}
