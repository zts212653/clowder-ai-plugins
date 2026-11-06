import { z } from 'zod';
import type { CommunityEvent } from '../../model/index.js';
import type { PrTerminalFacts } from '../../model/types/provider-terminal.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const date = z.string().datetime();
export const providerOpenSchema = z.object({ headSha: sha,
  observedAt: z.number().int().nonnegative().safe().optional(), providerUpdatedAt: date.optional() }).strict();
const review = z.object({ id: z.number().int().positive().safe(), author: z.string().min(1), state: z.string().min(1),
  commitId: sha.nullable(), submittedAt: date.nullable() }).strict();
const ciEvidence = z.object({ headSha: sha, status: z.enum(['pending', 'pass', 'fail', 'external_infrastructure', 'unknown']),
    source: z.literal('github-status-check-rollup'), observedAt: z.number().int().nonnegative().safe(), checkRollup: z.enum(['empty', 'present']),
    checks: z.array(z.object({ name: z.string().min(1), bucket: z.enum(['pass', 'fail', 'pending', 'external_infrastructure']), link: z.string().url().optional(), workflow: z.string().optional(),
      providerStatus: z.string().optional(), providerConclusion: z.string().nullable().optional() }).strict()),
  }).strict().superRefine((ci, context) => {
    if (ci.checkRollup === 'empty' && (ci.status !== 'unknown' || ci.checks.length !== 0) ||
        ci.checkRollup === 'present' && ci.checks.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: 'CI rollup evidence is inconsistent' });
  });

export const terminalFactsSchema = z.object({
  schemaVersion: z.literal(1), subjectKey: z.string().regex(/^pr:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/),
  state: z.enum(['merged', 'closed']), headSha: sha.nullable(), closedAt: date.nullable(), mergedAt: date.nullable(), mergeCommitSha: sha.nullable(),
  reviews: z.array(review),
  ci: ciEvidence.nullable(), ciHistory: z.array(ciEvidence).optional(),
  source: z.enum(['github-api', 'github-webhook']), observedAt: z.number().int().nonnegative().safe(),
}).strict().superRefine((facts, context) => {
  if (facts.ci && (facts.ci.headSha !== facts.headSha ||
      (facts.ci.checkRollup === 'empty' && (facts.ci.status !== 'unknown' || facts.ci.checks.length !== 0)) ||
      (facts.ci.checkRollup === 'present' && facts.ci.checks.length === 0))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'CI evidence does not match terminal HEAD or rollup' });
  if (facts.state === 'closed' && (facts.mergedAt || facts.mergeCommitSha)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'closed PR cannot attest a merge' });
});

export function parseTerminalFacts(value: unknown, subject: string): PrTerminalFacts {
  const facts = terminalFactsSchema.parse(value);
  if (facts.subjectKey !== subject) throw new TypeError('terminal provider subject mismatch');
  return { ...facts, reviews: [...facts.reviews].sort((a, b) => a.id - b.id),
    ci: facts.ci && { ...facts.ci, checks: [...facts.ci.checks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } };
}

function known<T>(previous: T | null, next: T | null): T | null {
  if (previous !== null && next !== null && previous !== next) throw new TypeError('conflicting terminal provider identity');
  return previous ?? next;
}

function knownDate(previous: string | null, next: string | null): string | null {
  if (previous !== null && next !== null && Date.parse(previous) !== Date.parse(next)) throw new TypeError('conflicting terminal provider identity');
  return previous ?? next;
}

function mergeReviewEvidence(previous: PrTerminalFacts['reviews'], next: PrTerminalFacts['reviews']) {
  const reviews = new Map(previous.map(item => [item.id, item]));
  for (const item of next) {
    const old = reviews.get(item.id);
    if (!old) { reviews.set(item.id, item); continue; }
    const preferred = old.state === 'DISMISSED' || item.state !== 'DISMISSED' && old.state !== 'PENDING' ? old : item;
    reviews.set(item.id, { ...preferred, commitId: known(old.commitId, item.commitId), submittedAt: old.submittedAt ?? item.submittedAt });
  }
  return [...reviews.values()].sort((a, b) => a.id - b.id);
}

function retainedCiHistory(previous: PrTerminalFacts, next: PrTerminalFacts, includePrevious = false) {
  const values = [...(previous.ciHistory ?? []), ...(includePrevious && previous.ci ? [previous.ci] : []), ...(next.ciHistory ?? [])];
  const ciHistory = [...new Map(values.map(item => [JSON.stringify(item), item])).values()]
    .sort((a, b) => a.observedAt - b.observedAt || a.headSha.localeCompare(b.headSha));
  return ciHistory.length ? { ciHistory } : {};
}

/** Merge evidence after the canonical reducer has established period identity.
 * This helper never decides lifecycle validity or whether a new period began. */
export function mergeTerminalFacts(previous: PrTerminalFacts | undefined, next: PrTerminalFacts, newPeriod = false): PrTerminalFacts {
  if (!previous) return next;
  if (newPeriod) return { ...next, reviews: mergeReviewEvidence(previous.reviews, next.reviews),
    ...retainedCiHistory(previous, next, true), observedAt: Math.max(previous.observedAt, next.observedAt) };
  const headSha = known(previous.headSha, next.headSha);
  const reviews = mergeReviewEvidence(previous.reviews, next.reviews);
  const ci = !previous.ci ? next.ci : !next.ci || next.ci.observedAt < previous.ci.observedAt ? previous.ci : next.ci;
  return { ...previous, state: next.state, headSha, closedAt: knownDate(previous.closedAt, next.closedAt),
    mergedAt: knownDate(previous.mergedAt, next.mergedAt), mergeCommitSha: known(previous.mergeCommitSha, next.mergeCommitSha),
    reviews, ci, ...retainedCiHistory(previous, next),
    source: previous.source === 'github-api' || next.source === 'github-api' ? 'github-api' : 'github-webhook',
    observedAt: Math.max(previous.observedAt, next.observedAt) };
}

export function terminalContent(facts: PrTerminalFacts): string {
  const { observedAt, ci, ...content } = facts;
  if (!ci) return JSON.stringify({ ...content, ci: null });
  const { observedAt: ciObservedAt, ...ciContent } = ci;
  return JSON.stringify({ ...content, ci: ciContent });
}

/** Old journal entries may have no commit association. Retain that uncertainty. */
export function terminalReviews(events: readonly CommunityEvent[]): PrTerminalFacts['reviews'] {
  const rows = new Map<number, PrTerminalFacts['reviews'][number]>();
  for (const event of events) {
    if (event.kind !== 'pr.review_submitted') continue;
    const p = event.payload;
    const candidate = review.safeParse({ id: p.reviewId, author: p.author ?? p.reviewerLogin,
      state: p.reviewState, commitId: p.commitId ?? null, submittedAt: p.submittedAt ?? null });
    if (!candidate.success || rows.get(candidate.data.id)?.state === 'DISMISSED') continue;
    rows.set(candidate.data.id, candidate.data);
  }
  return [...rows.values()].sort((a, b) => a.id - b.id);
}
