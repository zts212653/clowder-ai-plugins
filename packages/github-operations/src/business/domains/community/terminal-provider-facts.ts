import { createHash } from 'node:crypto';
import type { CommunityEvent, CommunityObjectProjection } from '../../model/index.js';
import type { PrTerminalFacts } from '../../model/types/provider-terminal.js';
import { parseTerminalFacts } from './terminal-provider-evidence.js';
import { currentProviderFacts, reduceProviderHistory } from './provider-period.js';
export * from './terminal-provider-evidence.js';

/** Content transitions retain an identity even when two reads share a clock
 * instant. The collector coalesces unchanged reads using its durable watermark. */
export function terminalObservationEvent(value: PrTerminalFacts, previousSourceEventId?: string, observation: PrTerminalFacts = value): CommunityEvent {
  const facts = parseTerminalFacts(value, value.subjectKey);
  const { observedAt, ...content } = facts;
  const hash = createHash('sha256').update(JSON.stringify({ content, previousSourceEventId })).digest('hex');
  return { sourceEventId: `terminal:${facts.subjectKey}:${observedAt}:${hash}`, subjectKey: facts.subjectKey,
    kind: 'pr.terminal_observed', classification: 'informational', payload: { terminalFacts: facts, providerObservedAt: observation.source === 'github-api' ? observation.observedAt : null }, at: observedAt };
}

export function shouldObserveTerminalFacts(history: readonly CommunityEvent[]): boolean {
  const period = reduceProviderHistory(history);
  return !period.state || period.state.enrolled;
}

/** Current provider display is independent of the native case's terminal state. */
export function providerProjectionFields(projection: CommunityObjectProjection) {
  const period = projection.providerPeriod && { state: projection.providerPeriod, facts: projection.terminalFacts };
  const facts = period ? currentProviderFacts(period) : projection.providerOpen ? undefined : projection.terminalFacts;
  if (projection.providerOpen || period?.state.enrolled && !facts) {
    const state = projection.providerOpen ? 'open' : period!.state.state;
    return { headSha: projection.providerOpen?.headSha ?? period?.state.headSha ?? '', state, status: state,
      group: state === 'open' ? 'unreplied' : state, terminalFacts: undefined,
      ...(projection.terminalFacts ? { historicalTerminalFacts: projection.terminalFacts } : {}) };
  }
  if (facts) return { headSha: facts.headSha ?? '', terminalFacts: facts, state: facts.state, status: facts.state, group: facts.state };
  return {};
}
