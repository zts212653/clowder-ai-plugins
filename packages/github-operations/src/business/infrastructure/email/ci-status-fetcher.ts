/** Shared effective CI facts; PR-local execution diagnostics are layered afterward. */
import { GitHubRateLimitError } from '../github/request-budget.js';
import type { CiCheckDetail, CiPollResult } from './ci-cd-contract.js';
import { enrichGitHubExecutionFailures } from './ci-execution-failure.js';
import { executeGh, normalizeBucket, type FetchPrCiStatusOptions } from './ci-status-common.js';
import { fetchExactPrCiStatus } from './ci-status-batch-fetcher.js';

export { executeGh, computeAggregateBucket, normalizeBucket, normalizePrState } from './ci-status-common.js';
export type { FetchPrCiStatusOptions, GhExecFileAsync } from './ci-status-common.js';
export { classifyGitHubExecutionFailure, type GitHubExecutionFailureEvidence } from './ci-execution-failure.js';

type MinimalLog = { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };

export async function fetchPrCiStatus(
  repoFullName: string, prNumber: number, log: MinimalLog, options: FetchPrCiStatusOptions = {},
): Promise<CiPollResult | null> {
  const poll = await fetchExactPrCiStatus({ repoFullName, prNumber }, log, options);
  return poll ? enrichPrCiStatus(poll, log, options) : null;
}

/** Diagnostics may narrow to required failures, but may never reintroduce an
 * obsolete check or replace a canonical result with an unrelated same-name job.
 */
export async function enrichPrCiStatus(
  poll: CiPollResult, log: MinimalLog, options: FetchPrCiStatusOptions = {},
): Promise<CiPollResult> {
  options.signal?.throwIfAborted();
  if (poll.prState !== 'open' || poll.aggregateBucket !== 'fail') return poll;
  const required = await fetchRequiredFailingChecks(poll.repoFullName, poll.prNumber, options);
  const matching = required?.map(check => poll.checks.find(current =>
    !!check.link && check.link === current.link && check.name === current.name && check.bucket === current.bucket));
  const checks = matching?.length && matching.every(check => check !== undefined)
    ? matching as CiCheckDetail[] : [...poll.checks];
  const enriched = await enrichGitHubExecutionFailures({
    signal: options.signal, repoFullName: poll.repoFullName, headSha: poll.headSha, checks,
    ghApiJson: path => ghApiJson(path, options), warn: message => log.warn(message),
  });
  return { ...poll, checks: enriched };
}

async function fetchGhCheckDetails(
  repoFullName: string,
  prNumber: number,
  requiredOnly: boolean,
  options: FetchPrCiStatusOptions,
): Promise<CiCheckDetail[]> {
  const args = [
    'pr',
    'checks',
    String(prNumber),
    '-R',
    repoFullName,
    '--json',
    'name,bucket,link,workflow,description',
  ];
  if (requiredOnly) args.push('--required');
  const { stdout } = await executeGh(args, options);
  const parsed = JSON.parse(stdout) as Array<{
    name: string;
    bucket: string;
    link?: string;
    workflow?: string;
    description?: string;
  }>;
  return parsed.map((check) => ({
    name: check.name,
    bucket: normalizeBucket(check.bucket),
    link: check.link,
    workflow: check.workflow,
    description: check.description,
  }));
}

/** Preserve the historical `gh pr checks --required` failure projection. */
export async function fetchRequiredFailingChecks(
  repoFullName: string,
  prNumber: number,
  options: FetchPrCiStatusOptions,
): Promise<CiCheckDetail[] | null> {
  try {
    const checks = await fetchGhCheckDetails(repoFullName, prNumber, true, options);
    return checks.some((check) => check.bucket === 'fail') ? checks : null;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof GitHubRateLimitError) throw error;
    return null;
  }
}

export async function ghApiJson<T>(path: string, options: FetchPrCiStatusOptions): Promise<T> {
  const { stdout } = await executeGh(['api', path], options);
  return JSON.parse(stdout) as T;
}
