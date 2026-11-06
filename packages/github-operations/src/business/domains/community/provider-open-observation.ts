import { createHash } from 'node:crypto';
import type { CommunityEvent } from '../../model/index.js';
import type { ProviderPeriodState } from '../../model/types/provider-terminal.js';
import { providerOpenSchema } from './terminal-provider-evidence.js';
import { reduceProviderEvent, reduceProviderHistory } from './provider-period.js';
export { observationIsOlder } from './provider-period.js';
export const openObservationSchema = providerOpenSchema;
export type ProviderOpenObservation = import('zod').infer<typeof providerOpenSchema>;
export interface ProviderStateEvidence {
  state: ProviderPeriodState['state']; event: CommunityEvent; period: ProviderPeriodState;
  observedAt: number | undefined; updatedAt: string | undefined; headSha?: string;
}
export function providerStateEvidence(history: readonly CommunityEvent[]): ProviderStateEvidence | undefined {
  const period = reduceProviderHistory(history).state;
  if (!period) return undefined;
  return { state: period.state, event: history.find(event => event.sourceEventId === period.sourceEventId)!, period,
    observedAt: period.observedAt ?? undefined, updatedAt: period.updatedAt ?? undefined,
    ...(period.headSha ? { headSha: period.headSha } : {}) };
}

export function providerOpenEvent(subject: string, current: ProviderStateEvidence | undefined, value: ProviderOpenObservation): { denied: boolean; event?: CommunityEvent; observed?: ProviderPeriodState | null } {
  const open = providerOpenSchema.parse(value);
  const id = createHash('sha256').update(JSON.stringify([current?.event.sourceEventId, open.headSha])).digest('hex');
  const event: CommunityEvent = { sourceEventId: `provider-open:${subject}:${id}`, subjectKey: subject,
    kind: 'pr.open_observed', classification: 'informational', payload: open, at: open.observedAt ?? Date.now() };
  const decision = reduceProviderEvent({ state: current?.period ?? null, facts: undefined }, event);
  if (!decision.accepted) return { denied: true };
  // Ordinary first opens stay in their existing native tracking path.
  return { denied: false, observed: decision.value.state,
    ...(!current || current.state === 'open' && current.headSha === open.headSha ? {} : { event }) };
}
