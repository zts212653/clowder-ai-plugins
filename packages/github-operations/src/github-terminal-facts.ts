import { z } from 'zod';
import type { GitHubReview } from './tracking-runtime.js';
import type { CiPollResult } from './business/infrastructure/email/ci-cd-contract.js';
import type { PrTerminalFacts } from './business/model/types/provider-terminal.js';
import { parseTerminalFacts } from './business/domains/community/terminal-provider-facts.js';

const metadataSchema = z.object({
  number: z.number().int().positive().safe(), html_url: z.string().url(), state: z.literal('closed'),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).passthrough().nullish(),
  closed_at: z.string().datetime().nullish(), merged_at: z.string().datetime().nullish(),
  merged: z.boolean().optional(), merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/i).nullish(),
}).passthrough();

/** Identity comes from the actual provider object, never a caller's fact body. */
export function terminalFactsFromProvider(input: {
  repo: string; number: number; metadata: unknown; reviews: readonly GitHubReview[];
  ci: CiPollResult | null; source: PrTerminalFacts['source']; observedAt: number;
}): PrTerminalFacts {
  const meta = metadataSchema.parse(input.metadata);
  const repo = input.repo.toLowerCase(), subjectKey = `pr:${repo}#${input.number}`;
  if (meta.number !== input.number || meta.html_url.toLowerCase() !== `https://github.com/${repo}/pull/${input.number}`) throw new TypeError('terminal provider subject identity mismatch');
  const headSha = meta.head?.sha.toLowerCase() ?? null;
  const status = input.ci;
  if (status && (status.identityVerified !== true || status.repoFullName.toLowerCase() !== repo || status.prNumber !== input.number || status.headSha.toLowerCase() !== headSha || !status.checkRollup)) throw new TypeError('terminal CI subject or commit identity mismatch');
  const state = meta.merged_at || meta.merged === true ? 'merged' : 'closed';
  const ciUncertain = status?.aggregateBucket === 'pending' && status.checks.every(check =>
    check.providerStatus === 'COMPLETED' || !check.providerStatus);
  return parseTerminalFacts({ schemaVersion: 1, subjectKey, state, headSha,
    closedAt: meta.closed_at ?? null, mergedAt: meta.merged_at ?? null,
    // GitHub also uses merge_commit_sha for an unmerged test merge. It is not
    // a merge fact on a PR which was closed without merging.
    mergeCommitSha: state === 'merged' ? meta.merge_commit_sha?.toLowerCase() ?? null : null,
    reviews: input.reviews.map(item => ({ id: item.id, author: item.author, state: item.state,
      commitId: item.commitId?.toLowerCase() ?? null, submittedAt: item.submittedAt ?? null })),
    ci: status ? { headSha, status: status.checkRollup === 'empty' || ciUncertain ? 'unknown' : status.aggregateBucket,
      source: 'github-status-check-rollup', observedAt: input.observedAt, checkRollup: status.checkRollup,
      checks: status.checks.map(item => ({ name: item.name, bucket: item.bucket,
        ...(item.providerStatus ? { providerStatus: item.providerStatus } : {}),
        ...(item.providerConclusion !== undefined ? { providerConclusion: item.providerConclusion } : {}),
        ...(item.link ? { link: item.link } : {}), ...(item.workflow ? { workflow: item.workflow } : {}) })) } : null,
    source: input.source, observedAt: input.observedAt,
  }, subjectKey);
}
