import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CommunityEvent } from '../../model/index.js';
import { providerOpenSchema, terminalFactsSchema } from './terminal-provider-facts.js';

export const openObservationSchema = providerOpenSchema;
export type ProviderOpenObservation = z.infer<typeof openObservationSchema>;
export interface ProviderStateEvidence {
  state: 'open' | 'closed' | 'merged'; event: CommunityEvent;
  observedAt?: number; updatedAt?: string; headSha?: string;
}

/** Native case events never change the provider's open/close period. */
export function providerStateEvidence(history: readonly CommunityEvent[]): ProviderStateEvidence | undefined {
  let current: ProviderStateEvidence | undefined;
  for (const event of history) {
    if (event.kind === 'pr.terminal_observed') {
      const parsed = terminalFactsSchema.safeParse(event.payload.terminalFacts);
      if (!parsed.success || parsed.data.subjectKey !== event.subjectKey) continue;
      const facts = parsed.data;
      if (current?.state === 'merged' && facts.state !== 'merged') continue;
      current = { state: facts.state, event, headSha: facts.headSha ?? undefined,
        ...(facts.source === 'github-api' ? { observedAt: facts.observedAt } : {}),
        updatedAt: facts.mergedAt ?? facts.closedAt ?? undefined };
    } else if (event.kind === 'pr.closed' || event.kind === 'pr.merged') {
      if (current?.state === 'merged' && event.kind !== 'pr.merged') continue;
      const state = event.kind === 'pr.merged' ? 'merged' : 'closed';
      const same = current?.state === state ? current : undefined;
      current = { state, event,
        observedAt: typeof event.payload.providerObservedAt === 'number' ? event.payload.providerObservedAt : same?.observedAt,
        updatedAt: typeof event.payload.closedAt === 'string' ? event.payload.closedAt : same?.updatedAt };
    } else if (event.kind === 'pr.open_observed' && current?.state !== 'merged') {
      const parsed = openObservationSchema.safeParse(event.payload);
      if (parsed.success) current = { state: 'open', event, ...parsed.data };
    }
  }
  return current;
}

export function observationIsOlder(current: Pick<ProviderStateEvidence, 'observedAt' | 'updatedAt'> | undefined,
  incoming: { observedAt?: number; providerUpdatedAt?: string }): boolean {
  if (!current) return false;
  if (current.updatedAt && incoming.providerUpdatedAt && Date.parse(incoming.providerUpdatedAt) !== Date.parse(current.updatedAt)) {
    return Date.parse(incoming.providerUpdatedAt) < Date.parse(current.updatedAt);
  }
  return current.observedAt !== undefined && incoming.observedAt !== undefined && incoming.observedAt < current.observedAt;
}

export function providerOpenEvent(subject: string, current: ProviderStateEvidence | undefined, value: ProviderOpenObservation) {
  const open = openObservationSchema.parse(value);
  if (current?.state === 'merged' || observationIsOlder(current, open)) return { denied: true };
  // A first open PR already uses its normal native/provider collection. This
  // event represents reopening or a changed HEAD in that observed open period.
  if (!current || current.state === 'open' && current.headSha === open.headSha) return { denied: false };
  const id = createHash('sha256').update(JSON.stringify([current.event.sourceEventId, open.headSha])).digest('hex');
  const event: CommunityEvent = { sourceEventId: `provider-open:${subject}:${id}`, subjectKey: subject,
    kind: 'pr.open_observed', classification: 'informational', payload: open, at: open.observedAt ?? Date.now() };
  return { denied: false, event };
}
