/** F304: batched GitHub GraphQL reader for one cicd-check tick. */
import { GitHubRateLimitError } from '../github/request-budget.js';
import type { CiPollResult } from './ci-cd-contract.js';
import { executeGh, type FetchPrCiStatusOptions } from './ci-status-common.js';
import { ciRollupFields, graphQlPrToPollResult, rollupPage, type GraphQlPr, type GraphQlRollupContext } from './ci-status-rollup.js';

export interface PrCiStatusTarget {
  readonly repoFullName: string;
  readonly prNumber: number;
}

export function ciStatusTargetKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

type MinimalLog = { warn: (...args: unknown[]) => void };

interface BatchTargetRef extends PrCiStatusTarget {
  readonly repoAlias: string;
  readonly prAlias: string;
}

interface BatchGraphQlResponse {
  readonly data?: Record<string, Record<string, GraphQlPr | null> | null>;
  readonly errors?: unknown;
}

function parseBatchGraphQlResponse(stdout: string): BatchGraphQlResponse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed != null && typeof parsed === 'object' ? (parsed as BatchGraphQlResponse) : null;
  } catch {
    return null;
  }
}

function stdoutFromExecError(error: unknown): string | null {
  if (error == null || typeof error !== 'object' || !('stdout' in error)) return null;
  const stdout = (error as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string') return stdout;
  return stdout instanceof Uint8Array ? new TextDecoder().decode(stdout) : null;
}

function hasPrErrors(parsed: BatchGraphQlResponse, ref: BatchTargetRef): boolean {
  if (!parsed.errors) return false;
  if (!Array.isArray(parsed.errors)) return true;
  return parsed.errors.some((error: { path?: unknown }) => !Array.isArray(error?.path) || error.path.length === 0 ||
    (error.path[0] === ref.repoAlias && (error.path.length < 2 || error.path[1] === ref.prAlias)));
}

function splitRepo(repoFullName: string): { owner: string; name: string } | null {
  const separator = repoFullName.indexOf('/');
  if (separator <= 0 || separator === repoFullName.length - 1 || repoFullName.indexOf('/', separator + 1) !== -1) {
    return null;
  }
  return { owner: repoFullName.slice(0, separator), name: repoFullName.slice(separator + 1) };
}

function buildBatchQuery(targets: readonly PrCiStatusTarget[], after?: string): {
  readonly query: string;
  readonly refs: readonly BatchTargetRef[];
} {
  const grouped = new Map<string, { repoAlias: string; owner: string; name: string; targets: BatchTargetRef[] }>();
  const refs: BatchTargetRef[] = [];
  for (const target of targets) {
    const repo = splitRepo(target.repoFullName);
    if (!repo || !Number.isSafeInteger(target.prNumber) || target.prNumber <= 0) continue;
    let group = grouped.get(target.repoFullName);
    if (!group) {
      group = { repoAlias: `r${grouped.size}`, ...repo, targets: [] };
      grouped.set(target.repoFullName, group);
    }
    const ref = { ...target, repoAlias: group.repoAlias, prAlias: `p${refs.length}` };
    group.targets.push(ref);
    refs.push(ref);
  }

  const repositories = [...grouped.values()].map((group) => {
    const pullRequests = group.targets
      .map(
        (target) => `${target.prAlias}: pullRequest(number: ${target.prNumber}) {
          headRefOid state mergedAt mergedBy { login }
          commits(last: 1) { nodes { commit { statusCheckRollup {
            contexts(first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}) { nodes {
              ${ciRollupFields}
            } pageInfo { hasNextPage endCursor } }
          } } } }
        }`,
      )
      .join('\n');
    return `${group.repoAlias}: repository(owner: ${JSON.stringify(group.owner)}, name: ${JSON.stringify(group.name)}) {
      ${pullRequests}
    }`;
  });
  return { query: `query BatchPrCi { ${repositories.join('\n')} }`, refs };
}

/**
 * One GraphQL process reads every tracked PR's state and status rollup.
 * Admission only reads base facts. Exact pagination and typed failure diagnostics
 * belong to the individual PR work item, never the shared batch deadline.
 */
export async function fetchPrCiStatuses(
  targets: readonly PrCiStatusTarget[],
  log: MinimalLog,
  options: FetchPrCiStatusOptions = {},
): Promise<ReadonlyMap<string, CiPollResult | null>> {
  const results = new Map<string, CiPollResult | null>(
    targets.map((target) => [ciStatusTargetKey(target.repoFullName, target.prNumber), null]),
  );
  const { query, refs } = buildBatchQuery(targets);
  if (refs.length === 0) return results;

  let parsed: BatchGraphQlResponse | null;
  try {
    const { stdout } = await executeGh(['api', 'graphql', '-f', `query=${query}`], options);
    parsed = parseBatchGraphQlResponse(stdout);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof GitHubRateLimitError) throw error;
    parsed = parseBatchGraphQlResponse(stdoutFromExecError(error) ?? '');
    if (!parsed?.data) {
      log.warn(`[ci-status] batched GraphQL poll failed for ${refs.length} PRs: ${String(error)}`);
      return results;
    }
  }
  if (!parsed) {
    log.warn(`[ci-status] failed to parse batched GraphQL poll for ${refs.length} PRs`);
    return results;
  }
  if (parsed.errors) log.warn('[ci-status] batched GraphQL poll returned partial errors');

  for (const ref of refs) {
    options.signal?.throwIfAborted();
    const pr = parsed.data?.[ref.repoAlias]?.[ref.prAlias];
    if (!pr?.headRefOid || hasPrErrors(parsed, ref)) continue;
    results.set(ciStatusTargetKey(ref.repoFullName, ref.prNumber), graphQlPrToPollResult(ref, pr));
  }
  return results;
}

/** PR-local pagination; never run inside the shared batch deadline. Every page
 * must observe the same HEAD, otherwise this poll has no coherent snapshot.
 */
export async function fetchExactPrCiStatus(
  target: PrCiStatusTarget, log: MinimalLog, options: FetchPrCiStatusOptions,
): Promise<CiPollResult | null> {
  let first: GraphQlPr | undefined;
  const contexts: Array<GraphQlRollupContext | null> = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const { query, refs } = buildBatchQuery([target], after);
    const ref = refs[0];
    if (!ref) return null;
    let parsed: BatchGraphQlResponse | null;
    try {
      const { stdout } = await executeGh(['api', 'graphql', '-f', `query=${query}`], options);
      parsed = parseBatchGraphQlResponse(stdout);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof GitHubRateLimitError) throw error;
      log.warn(`[ci-status] exact GraphQL poll failed for ${target.repoFullName}#${target.prNumber}: ${String(error)}`);
      return null;
    }
    const pr = parsed?.data?.[ref.repoAlias]?.[ref.prAlias];
    if (!parsed || !pr?.headRefOid || hasPrErrors(parsed, ref) || (first && first.headRefOid !== pr.headRefOid)) return null;
    first ??= pr;
    const page = rollupPage(pr);
    if (pr.state !== 'OPEN' || !page) return graphQlPrToPollResult(target, pr);
    if (!page.nodes || typeof page.pageInfo?.hasNextPage !== 'boolean') return null;
    contexts.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return graphQlPrToPollResult(target, {
      ...pr, commits: { nodes: [{ commit: { statusCheckRollup: {
        contexts: { nodes: contexts, pageInfo: { hasNextPage: false } },
      } } }] },
    });
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) return null;
    cursors.add(cursor); after = cursor;
  }
}
