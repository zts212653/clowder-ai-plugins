import { z } from 'zod';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from './business/model/index.js';
import type { PrTerminalFacts } from './business/model/types/provider-terminal.js';
import type { ICommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import type { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { mergeTerminalFacts, parseTerminalFacts, terminalContent, terminalObservationEvent, terminalReviews } from './business/domains/community/terminal-provider-facts.js';
import { communityProgressKey } from './legacy-repository-progress.js';
import { providerOpenEvent, providerStateEvidence, type ProviderOpenObservation } from './business/domains/community/provider-open-observation.js';
import { isProviderPeriodEvent, normalizeProviderLifecycle, reduceProviderEvent, reduceProviderHistory, withProviderClockFloor } from './business/domains/community/provider-period.js';

const checkpointSchema = z.object({ v: z.literal(1), sourceEventId: z.string(),
  observedAt: z.number().int().nonnegative().safe(), ciObservedAt: z.number().int().nonnegative().safe().nullable(),
  stateSourceEventId: z.string().optional(), stateObservedAt: z.number().int().nonnegative().safe().optional(),
  stateUpdatedAt: z.string().datetime().optional() }).strict();

/** Journal facts own the period. A source-matched bounded checkpoint advances
 * unchanged read/CI watermarks without adding business events. */
export class TerminalFactCollection {
  constructor(private readonly storage: PluginStorageHost, private readonly events: ICommunityEventLog,
    private readonly projector: CommunityProjector, private readonly operations: CommunityProjectionOperations,
    private readonly signal?: AbortSignal) {}

  async allowed(subject: string): Promise<boolean> {
    const period = reduceProviderHistory(await this.events.read(subject));
    return !period.state || period.state.enrolled;
  }

  async collect(subject: string, batch: readonly CommunityEvent[], incoming?: PrTerminalFacts, historicalAuthorized = false, open?: ProviderOpenObservation) {
    const result = await this.operations.run(subject, async () => {
      this.signal?.throwIfAborted();
      const history = await this.events.read(subject), canonical = reduceProviderHistory(history);
      const key = communityProgressKey('terminal-observation', subject), raw = await this.storage.get(key);
      const checkpoint = raw ? checkpointSchema.parse(raw.value) : undefined;
      const matchedState = checkpoint?.stateSourceEventId === canonical.state?.sourceEventId;
      const matchedFacts = checkpoint?.sourceEventId === canonical.state?.factSourceEventId;
      let period = { state: canonical.state && { ...canonical.state,
        observedAt: matchedState ? checkpoint?.stateObservedAt ?? canonical.state.observedAt : canonical.state.observedAt,
        updatedAt: matchedState ? checkpoint?.stateUpdatedAt ?? canonical.state.updatedAt : canonical.state.updatedAt },
        facts: canonical.facts && { ...canonical.facts,
          observedAt: matchedFacts ? Math.max(canonical.facts.observedAt, checkpoint!.observedAt) : canonical.facts.observedAt,
          ci: canonical.facts.ci && { ...canonical.facts.ci, observedAt: matchedFacts
            ? Math.max(canonical.facts.ci.observedAt, checkpoint!.ciObservedAt ?? 0) : canonical.facts.ci.observedAt } } };
      const stateEvidence = providerStateEvidence(history);
      const reopening = open ? providerOpenEvent(subject, stateEvidence && { ...stateEvidence,
        period: period.state!, observedAt: period.state!.observedAt ?? undefined,
        updatedAt: period.state!.updatedAt ?? undefined }, open) : undefined;
      if (reopening?.denied || !historicalAuthorized && period.state && !period.state.enrolled && !reopening?.event) return { denied: true, recorded: false };
      const rows: CommunityEvent[] = [];
      if (reopening?.event) {
        const next = reduceProviderEvent(period, reopening.event).value;
        rows.push(withProviderClockFloor(reopening.event, next.state!)); period = next;
      }
      else if (open && period.state && reopening?.observed) period = { ...period,
        state: { ...period.state, observedAt: reopening.observed.observedAt, updatedAt: reopening.observed.updatedAt } };
      let observation: CommunityEvent | undefined;
      if (incoming) {
        const supplied = parseTerminalFacts(incoming, subject);
        const input = mergeTerminalFacts({ ...supplied, reviews: terminalReviews([...history, ...batch]) }, supplied);
        const decision = reduceProviderEvent(period, terminalObservationEvent(input, canonical.state?.factSourceEventId ?? undefined));
        if (!decision.accepted) {
          if (decision.reason === 'invalid') throw new TypeError('Invalid or conflicting terminal provider subject or commit identity');
          return { denied: true, recorded: false };
        }
        const facts = decision.value.facts!;
        if (canonical.state?.factsPeriodId !== decision.value.state?.periodId ||
            !canonical.facts || terminalContent(facts) !== terminalContent(canonical.facts)) {
          observation = terminalObservationEvent(facts, canonical.state?.factSourceEventId ?? undefined, supplied);
          observation = { ...observation, payload: { ...observation.payload, providerObservedAt: decision.value.state!.observedAt } };
          if (historicalAuthorized && !canonical.state?.enrolled) observation = { ...observation, payload: { ...observation.payload, factsOnly: true } };
          observation = withProviderClockFloor(observation, decision.value.state!);
          rows.push(observation); period = reduceProviderEvent(period, observation).value;
        } else period = { ...decision.value, state: period.state && { ...period.state,
          observedAt: decision.value.state!.observedAt, updatedAt: decision.value.state!.updatedAt } };
      }
      for (const rawEvent of batch) {
        const proposed = reduceProviderEvent(period, rawEvent);
        if (!proposed.accepted && isProviderPeriodEvent(rawEvent)) {
          if (proposed.reason === 'facts_only') continue;
          if (proposed.reason === 'invalid') throw new TypeError('Invalid or conflicting terminal provider subject or commit identity');
          return { denied: true, recorded: false };
        }
        const event = normalizeProviderLifecycle(rawEvent, period);
        // A retry of a committed lifecycle is not new work. In particular it
        // cannot turn historical fact enrollment into a new merge cascade.
        if (isProviderPeriodEvent(event) && history.some(item => item.sourceEventId === event.sourceEventId)) continue;
        const decision = reduceProviderEvent(period, event);
        if (!decision.accepted && isProviderPeriodEvent(event)) {
          if (decision.reason === 'facts_only') continue;
          if (decision.reason === 'invalid') throw new TypeError('Invalid or conflicting terminal provider subject or commit identity');
          return { denied: true, recorded: false };
        }
        rows.push(isProviderPeriodEvent(event) ? withProviderClockFloor(event, decision.value.state!) : event); period = decision.value;
      }
      // Validate the complete batch before its first write. The same reducer is
      // used by projection if another producer later appends a stale raw event.
      let recorded = false;
      for (const event of rows) {
        this.signal?.throwIfAborted();
        const result = await this.events.append(event);
        if (event === observation) recorded = result.appended;
      }
      const after = reduceProviderHistory(await this.events.read(subject));
      const sourceEventId = after.state?.factSourceEventId ?? after.state?.sourceEventId;
      if (sourceEventId && after.state!.enrolled && (incoming || open || batch.some(isProviderPeriodEvent))) {
        this.signal?.throwIfAborted();
        await this.storage.set(key, { v: 1, sourceEventId,
          observedAt: period.facts?.observedAt ?? checkpoint?.observedAt ?? 0,
          ciObservedAt: period.facts?.ci?.observedAt ?? null,
          stateSourceEventId: after.state!.sourceEventId,
          ...(period.state?.observedAt !== null && period.state?.observedAt !== undefined ? { stateObservedAt: period.state.observedAt } : {}),
          ...(period.state?.updatedAt ? { stateUpdatedAt: period.state.updatedAt } : {}),
        });
      }
      return { denied: false, recorded };
    });
    if (!result.denied) await this.projector.catchUp(subject);
    else await this.projector.resumeFollowUps(subject);
    return result;
  }
}
