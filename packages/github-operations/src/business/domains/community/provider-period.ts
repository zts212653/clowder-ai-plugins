import { createHash } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { CommunityEvent } from '../../model/index.js';
import type { PrTerminalFacts, ProviderPeriodState } from '../../model/types/provider-terminal.js';
import { mergeTerminalFacts, parseTerminalFacts, providerOpenSchema, terminalReviews } from './terminal-provider-evidence.js';

export interface ProviderPeriod {
  readonly state: ProviderPeriodState | null;
  readonly facts: PrTerminalFacts | undefined;
}
export interface ProviderPeriodDecision {
  readonly accepted: boolean;
  readonly value: ProviderPeriod;
  readonly reason?: 'stale' | 'invalid' | 'facts_only';
}
const clocks = z.object({ providerObservedAt: z.number().int().nonnegative().safe().nullish(),
  closedAt: z.string().datetime().nullish(), mergedAt: z.string().datetime().nullish() }).passthrough();
const kinds = new Set(['pr.open_observed', 'pr.closed', 'pr.merged', 'pr.terminal_observed']);
export const isProviderPeriodEvent = (event: CommunityEvent) => event.subjectKey.startsWith('pr:') && kinds.has(event.kind);

export function observationIsOlder(current: { observedAt?: number | null; updatedAt?: string | null } | null | undefined,
  incoming: { observedAt?: number | null; providerUpdatedAt?: string | null }): boolean {
  if (!current) return false;
  if (current.updatedAt && incoming.providerUpdatedAt && Date.parse(incoming.providerUpdatedAt) !== Date.parse(current.updatedAt)) {
    return Date.parse(incoming.providerUpdatedAt) < Date.parse(current.updatedAt);
  }
  return current.observedAt != null && incoming.observedAt != null && incoming.observedAt < current.observedAt;
}

/** One transition policy for journal replay, admission and projection. Rejected
 * events never become the next event's state/clock/enrollment baseline. */
export function reduceProviderEvent(previous: ProviderPeriod, event: CommunityEvent): ProviderPeriodDecision {
  if (!isProviderPeriodEvent(event)) {
    if (event.kind !== 'pr.review_submitted' || !previous.facts) return { accepted: true, value: previous };
    try {
      const facts = mergeTerminalFacts(previous.facts, { ...previous.facts,
        reviews: terminalReviews([event]), observedAt: event.at });
      return { accepted: true, value: { ...previous, facts } };
    } catch (error) {
      if (error instanceof TypeError || error instanceof ZodError) return { accepted: false, value: previous, reason: 'invalid' };
      throw error;
    }
  }
  try {
    let facts: PrTerminalFacts | undefined;
    let state: ProviderPeriodState['state'], observedAt: number | null, updatedAt: string | null, headSha: string | null;
    if (event.kind === 'pr.open_observed') {
      const open = providerOpenSchema.parse(event.payload);
      state = 'open'; observedAt = open.observedAt ?? null; updatedAt = open.providerUpdatedAt ?? null; headSha = open.headSha;
    } else if (event.kind === 'pr.terminal_observed') {
      facts = parseTerminalFacts(event.payload.terminalFacts, event.subjectKey);
      state = facts.state; observedAt = Object.hasOwn(event.payload, 'providerObservedAt')
        ? clocks.parse(event.payload).providerObservedAt ?? null : facts.source === 'github-api' ? facts.observedAt : null;
      updatedAt = facts.mergedAt ?? facts.closedAt; headSha = facts.headSha;
    } else {
      const payload = clocks.parse(event.payload);
      state = event.kind === 'pr.merged' ? 'merged' : 'closed';
      observedAt = payload.providerObservedAt ?? null; updatedAt = payload.mergedAt ?? payload.closedAt ?? null;
      headSha = typeof event.payload.headSha === 'string' && /^[a-f0-9]{40}$/.test(event.payload.headSha) ? event.payload.headSha : null;
    }
    const current = previous.state;
    const sameClosing = current?.state === state && state !== 'open' &&
      (!current.updatedAt || !updatedAt || Date.parse(current.updatedAt) === Date.parse(updatedAt));
    if (sameClosing && current?.headSha && headSha && current.headSha !== headSha) return { accepted: false, value: previous, reason: 'invalid' };
    const older = observationIsOlder(current, { observedAt, providerUpdatedAt: updatedAt });
    if (current?.state === 'merged' && state !== 'merged' || older && !sameClosing ||
        current?.state === 'open' && state !== 'open' && observedAt === null && updatedAt === null) {
      return { accepted: false, value: previous, reason: 'stale' };
    }
    if (current?.state === 'merged' && state === 'merged' && current.updatedAt && updatedAt && Date.parse(current.updatedAt) !== Date.parse(updatedAt)) {
      return { accepted: false, value: previous, reason: older ? 'stale' : 'invalid' };
    }
    if (facts && sameClosing && current) facts = { ...facts, headSha: facts.headSha ?? current.headSha,
      ...(state === 'merged' ? { mergedAt: facts.mergedAt ?? current.updatedAt } : { closedAt: facts.closedAt ?? current.updatedAt }) };
    const newPeriod = !!current && (state === 'open' && current.state !== 'open' ||
      state !== 'open' && current.state !== 'open' && !sameClosing);
    if (!facts && state !== 'open' && current?.factsOnly && !newPeriod) return { accepted: false, value: previous, reason: 'facts_only' };
    const periodId = !newPeriod ? current?.periodId ?? 'initial' : state === 'open' ? event.sourceEventId
      : 'provider-period:' + createHash('sha256').update(JSON.stringify([current!.periodId, state, updatedAt ? Date.parse(updatedAt) : observedAt ?? 'unknown'])).digest('hex');
    const merged = facts ? mergeTerminalFacts(previous.facts, facts, !!previous.facts && current?.factsPeriodId !== periodId) : previous.facts;
    const retainClocks = !!current && !newPeriod;
    const requestClock = retainClocks ? Math.max(current.observedAt ?? 0, observedAt ?? 0) || null : observedAt;
    const providerClock = retainClocks && current.state === state && current.updatedAt && (!updatedAt || Date.parse(current.updatedAt) > Date.parse(updatedAt))
      ? current.updatedAt : updatedAt;
    const next: ProviderPeriodState = { state, sourceEventId: event.sourceEventId, periodId,
      observedAt: requestClock, updatedAt: providerClock,
      headSha: facts ? merged!.headSha : headSha ?? (retainClocks && current?.state === state ? current.headSha : null),
      enrolled: !!current?.enrolled || !!facts || state === 'open' ||
        event.payload.providerPeriodId !== undefined && (observedAt !== null || updatedAt !== null),
      factsOnly: facts && event.payload.factsOnly === true || !newPeriod && !!current?.factsOnly,
      lifecycleSourceEventId: (event.kind === 'pr.closed' || event.kind === 'pr.merged') && !event.sourceEventId.endsWith(':body-enrichment')
        ? event.sourceEventId : newPeriod ? null : current?.lifecycleSourceEventId ?? null,
      factSourceEventId: facts ? event.sourceEventId : current?.factSourceEventId ?? null,
      factsPeriodId: facts ? periodId : current?.factsPeriodId ?? null };
    return { accepted: true, value: { state: next, facts: merged } };
  } catch (error) {
    if (error instanceof TypeError || error instanceof ZodError) return { accepted: false, value: previous, reason: 'invalid' };
    throw error;
  }
}

export function reduceProviderHistory(history: readonly CommunityEvent[]): ProviderPeriod {
  return history.reduce((period, event) => reduceProviderEvent(period, event).value,
    { state: null, facts: undefined } as ProviderPeriod);
}

export function currentProviderFacts(period: ProviderPeriod): PrTerminalFacts | undefined {
  return period.state && period.state.state !== 'open' && period.state.factsPeriodId === period.state.periodId &&
    period.facts?.state === period.state.state ? period.facts : undefined;
}

/** Initial IDs retain cross-producer compatibility. A reopened or unobserved
 * later close period has its own stable identity, including summary-only reads. */
export function normalizeProviderLifecycle(event: CommunityEvent, period: ProviderPeriod): CommunityEvent {
  if (!event.subjectKey.startsWith('pr:') || !['pr.closed', 'pr.merged'].includes(event.kind)) return event;
  const decision = reduceProviderEvent(period, event);
  const id = decision.value.state?.periodId ?? 'initial';
  const changed = id !== period.state?.periodId;
  const suffix = id === 'initial' ? '' : ':period:' + createHash('sha256').update(id).digest('hex');
  const enrichment = event.sourceEventId.endsWith(':body-enrichment') ? ':body-enrichment' : '';
  const original = !changed && period.state?.state === (event.kind === 'pr.merged' ? 'merged' : 'closed') ? period.state.lifecycleSourceEventId : null;
  const base = original ?? `lifecycle:${event.subjectKey}:${event.kind === 'pr.merged' ? 'merged' : 'closed'}${suffix}`;
  return { ...event, sourceEventId: `${base}${enrichment}`,
    payload: { ...event.payload, providerPeriodId: id } };
}
