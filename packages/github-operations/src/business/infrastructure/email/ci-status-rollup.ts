import type { CiCheckDetail, CiPollResult } from './ci-cd-contract.js';
import { computeAggregateBucket, normalizeBucket, normalizePrState } from './ci-status-common.js';

export interface GraphQlCheckRun {
  readonly __typename: 'CheckRun';
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl?: string | null;
  readonly checkSuite?: {
    readonly app?: { readonly id: string } | null;
    readonly commit?: { readonly oid: string };
    readonly workflowRun?: {
      readonly id?: string;
      readonly runNumber?: number;
      readonly runAttempt?: number;
      readonly workflow?: { readonly id?: string; readonly name?: string | null } | null;
    } | null;
  } | null;
}

interface GraphQlStatusContext {
  readonly __typename: 'StatusContext';
  readonly context: string;
  readonly state: string;
  readonly description?: string | null;
  readonly targetUrl?: string | null;
}

export type GraphQlRollupContext = GraphQlCheckRun | GraphQlStatusContext;
export interface RollupPage {
  readonly nodes?: readonly (GraphQlRollupContext | null)[];
  readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null };
}

export interface GraphQlPr {
  readonly headRefOid: string;
  readonly state: string;
  readonly mergedAt: string | null;
  readonly mergedBy: { readonly login?: string | null } | null;
  readonly commits?: { readonly nodes?: ReadonlyArray<{
    readonly commit?: { readonly statusCheckRollup?: { readonly contexts?: RollupPage | null } | null } | null;
  } | null> } | null;
}

export const ciRollupFields = `
  __typename
  ... on CheckRun { name status conclusion detailsUrl checkSuite {
    app { id } commit { oid } workflowRun { id runNumber runAttempt workflow { id name } }
  } }
  ... on StatusContext { context state description targetUrl }
`;

export function rollupPage(pr: GraphQlPr): RollupPage | null | undefined {
  return pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts;
}

function identity(check: GraphQlRollupContext, headSha: string) {
  if (check.__typename !== 'CheckRun') return null;
  const suite = check.checkSuite;
  const run = suite?.workflowRun;
  const number = run?.runNumber;
  const attempt = run?.runAttempt;
  if (!suite?.app?.id || suite.commit?.oid !== headSha || !run?.id || !run.workflow?.id ||
    typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0 ||
    typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt <= 0) return null;
  return { key: JSON.stringify([suite.app.id, run.workflow.id, check.name]), runId: run.id, number, attempt };
}

/** Only a verified same-producer/workflow/check at this HEAD can replace a result.
 * Missing identities and distinct legacy contexts remain independent evidence.
 * WorkflowRun.runAttempt is current suite metadata, not a per-job attempt stamp.
 * Equal run/attempt duplicates remain independent: a larger check ID alone does
 * not prove supersession (two jobs can share a display name in the same run).
 */
function effectiveContexts(contexts: readonly GraphQlRollupContext[], headSha: string): readonly GraphQlRollupContext[] {
  const groups = new Map<string, Array<NonNullable<ReturnType<typeof identity>>>>();
  const identities = new Map<GraphQlRollupContext, NonNullable<ReturnType<typeof identity>>>();
  for (const check of contexts) {
    const info = identity(check, headSha);
    if (!info || check.__typename !== 'CheckRun') continue;
    identities.set(check, info);
    // Cancellation is a non-result: it can be replaced, but cannot erase a
    // preceding real result in either a newer run or a newer attempt.
    if (check.conclusion?.toLowerCase() === 'cancelled') continue;
    const group = groups.get(info.key) ?? [];
    group.push(info); groups.set(info.key, group);
  }
  return contexts.filter(check => {
    const info = identities.get(check);
    if (!info || check.__typename !== 'CheckRun') return true;
    return !groups.get(info.key)?.some(other => {
      if (other.number !== info.number) return other.number > info.number;
      if (other.runId !== info.runId) return false;
      return other.attempt > info.attempt;
    });
  });
}

function mapCheck(context: GraphQlRollupContext): CiCheckDetail {
  if (context.__typename === 'StatusContext') return {
    name: context.context, bucket: normalizeBucket(context.state),
    ...(context.targetUrl ? { link: context.targetUrl } : {}),
    ...(context.description ? { description: context.description } : {}),
  };
  const conclusion = context.conclusion?.toLowerCase();
  const bucket = conclusion === 'skipped' || conclusion === 'neutral' ? 'pass' :
    conclusion === 'timed_out' ? 'fail' : normalizeBucket(context.conclusion ?? context.status);
  const workflow = context.checkSuite?.workflowRun?.workflow?.name;
  return { name: context.name, bucket,
    ...(context.detailsUrl ? { link: context.detailsUrl } : {}), ...(workflow ? { workflow } : {}) };
}

export function graphQlPrToPollResult(
  target: { readonly repoFullName: string; readonly prNumber: number }, pr: GraphQlPr,
): CiPollResult | null {
  const prState = normalizePrState(pr.state, pr.mergedAt);
  const base = { repoFullName: target.repoFullName, prNumber: target.prNumber, headSha: pr.headRefOid, prState };
  if (prState !== 'open') return { ...base, aggregateBucket: 'pending', checks: [],
    ...(pr.mergedBy?.login ? { mergedByLogin: pr.mergedBy.login } : {}) };
  const page = rollupPage(pr);
  if (page && (page.pageInfo?.hasNextPage !== false || !page.nodes || page.nodes.some(x => !x))) return null;
  const contexts = effectiveContexts((page?.nodes ?? []) as readonly GraphQlRollupContext[], pr.headRefOid);
  const rollup = contexts.map(context => ({
    status: context.__typename === 'StatusContext' ? context.state : context.status,
    conclusion: context.__typename === 'StatusContext' ? '' : (context.conclusion ?? ''),
    __typename: context.__typename,
  }));
  return { ...base, aggregateBucket: computeAggregateBucket(rollup),
    checkRollup: contexts.length === 0 ? 'empty' : 'present', checks: contexts.map(mapCheck) };
}
