import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CommunityEvent, CommunityObjectProjection } from '../../model/index.js';
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

/** Content transitions retain an identity even when two reads share a clock
 * instant. The collector coalesces unchanged reads using its durable watermark. */
export function terminalObservationEvent(value: PrTerminalFacts, previousSourceEventId?: string): CommunityEvent {
  const facts = parseTerminalFacts(value, value.subjectKey);
  const { observedAt, ...content } = facts;
  const hash = createHash('sha256').update(JSON.stringify({ content, previousSourceEventId })).digest('hex');
  return { sourceEventId: `terminal:${facts.subjectKey}:${observedAt}:${hash}`, subjectKey: facts.subjectKey,
    kind: 'pr.terminal_observed', classification: 'informational', payload: { terminalFacts: facts }, at: observedAt };
}

function known<T>(previous: T | null, next: T | null): T | null {
  if (previous !== null && next !== null && previous !== next) throw new TypeError('conflicting terminal provider identity');
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

/** Merge sparse webhook observations with API reads without erasing provenance.
 * Provider observation time orders mutable CI/review facts; terminal identity is
 * immutable within a close cycle, and a merge cannot be reopened by late input. */
export function mergeTerminalFacts(previous: PrTerminalFacts | undefined, next: PrTerminalFacts): PrTerminalFacts {
  if (!previous) return next;
  if (previous.state === 'merged' && next.state === 'closed') return previous;
  const oldTime = Date.parse(previous.mergedAt ?? previous.closedAt ?? '') || 0;
  const newTime = Date.parse(next.mergedAt ?? next.closedAt ?? '') || 0;
  if (newTime && oldTime && newTime < oldTime) return previous;
  if (previous.state === 'closed' && (next.state === 'merged' || newTime > oldTime && oldTime > 0)) {
    const currentPreviousCi = previous.ci && next.headSha === previous.ci.headSha && newTime > 0 && previous.ci.observedAt >= newTime ? previous.ci : null;
    const ci = !currentPreviousCi ? next.ci : !next.ci || next.ci.observedAt < currentPreviousCi.observedAt ? currentPreviousCi : next.ci;
    return { ...next, reviews: mergeReviewEvidence(previous.reviews, next.reviews), ci,
      ...retainedCiHistory(previous, next, true), observedAt: Math.max(previous.observedAt, next.observedAt) };
  }
  const headSha = known(previous.headSha, next.headSha);
  const reviews = mergeReviewEvidence(previous.reviews, next.reviews);
  const ci = !previous.ci ? next.ci : !next.ci || next.ci.observedAt < previous.ci.observedAt ? previous.ci : next.ci;
  return { ...previous, state: next.state, headSha, closedAt: known(previous.closedAt, next.closedAt),
    mergedAt: known(previous.mergedAt, next.mergedAt), mergeCommitSha: known(previous.mergeCommitSha, next.mergeCommitSha),
    reviews, ci, ...retainedCiHistory(previous, next),
    source: previous.source === 'github-api' || next.source === 'github-api' ? 'github-api' : 'github-webhook',
    observedAt: Math.max(previous.observedAt, next.observedAt) };
}

/** Provider history owns admission. Native decline is not a provider closure,
 * and deleting a derived cache does not create a new provider subject. */
export function shouldObserveTerminalFacts(history: readonly CommunityEvent[]): boolean {
  let closed = false;
  let merged = false;
  let observedCurrentPeriod = false;
  for (const event of history) {
    if (event.kind === 'pr.merged') { closed = true; merged = true; }
    if (event.kind === 'pr.closed') closed = true;
    if (event.kind === 'pr.open_observed' && !merged && providerOpenSchema.safeParse(event.payload).success) { closed = false; observedCurrentPeriod = true; }
    if (event.kind !== 'pr.terminal_observed') continue;
    if (terminalFactsSchema.safeParse(event.payload.terminalFacts).success &&
        (event.payload.terminalFacts as PrTerminalFacts).subjectKey === event.subjectKey) return true;
  }
  return observedCurrentPeriod || !closed;
}

/** Current provider display is independent of the native case's terminal state. */
export function providerProjectionFields(projection: CommunityObjectProjection) {
  if (projection.providerOpen) return { headSha: projection.providerOpen.headSha, state: 'open' as const,
    status: 'open' as const, group: 'unreplied' as const, terminalFacts: undefined,
    ...(projection.terminalFacts ? { historicalTerminalFacts: projection.terminalFacts } : {}) };
  if (projection.terminalFacts) return { headSha: projection.terminalFacts.headSha ?? '', terminalFacts: projection.terminalFacts,
    state: projection.terminalFacts.state, status: projection.terminalFacts.state, group: projection.terminalFacts.state };
  return {};
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
