import { z, ZodError } from 'zod';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from './business/model/index.js';
import type { PrTerminalFacts } from './business/model/types/provider-terminal.js';
import type { ICommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import type { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { mergeTerminalFacts, parseTerminalFacts, shouldObserveTerminalFacts, terminalContent, terminalObservationEvent, terminalReviews } from './business/domains/community/terminal-provider-facts.js';
import { communityProgressKey } from './legacy-repository-progress.js';
import { observationIsOlder, providerOpenEvent, providerStateEvidence, type ProviderOpenObservation } from './business/domains/community/provider-open-observation.js';

const checkpointSchema = z.object({ v: z.literal(1), sourceEventId: z.string(),
  observedAt: z.number().int().nonnegative().safe(), ciObservedAt: z.number().int().nonnegative().safe().nullable(),
  stateSourceEventId: z.string().optional(), stateObservedAt: z.number().int().nonnegative().safe().optional(),
  stateUpdatedAt: z.string().datetime().optional() }).strict();

function finalHistory(history: readonly CommunityEvent[]) {
  let facts: PrTerminalFacts | undefined, sourceEventId: string | undefined;
  for (const event of history) {
    try {
      if (event.kind === 'pr.terminal_observed') {
        facts = mergeTerminalFacts(facts, parseTerminalFacts(event.payload.terminalFacts, event.subjectKey));
        sourceEventId = event.sourceEventId;
      } else if (facts && event.kind === 'pr.review_submitted') {
        const next = mergeTerminalFacts(facts, { ...facts, reviews: terminalReviews([event]), observedAt: event.at });
        facts = next;
      }
    } catch (error) { if (!(error instanceof TypeError || error instanceof ZodError)) throw error; }
  }
  return { facts, sourceEventId };
}

/** The existing journal owns facts; one bounded progress checkpoint owns read
 * watermarks. Unchanged reads need no new event but must fence delayed changes.
 * The checkpoint references a committed source and survives cache rebuilds. */
export class TerminalFactCollection {
  constructor(private readonly storage: PluginStorageHost, private readonly events: ICommunityEventLog,
    private readonly projector: CommunityProjector, private readonly operations: CommunityProjectionOperations,
    private readonly signal?: AbortSignal) {}

  async allowed(subject: string): Promise<boolean> {
    return shouldObserveTerminalFacts(await this.events.read(subject));
  }

  async collect(subject: string, batch: readonly CommunityEvent[], incoming?: PrTerminalFacts, historicalAuthorized = false, open?: ProviderOpenObservation) {
    const result = await this.operations.run(subject, async () => {
      this.signal?.throwIfAborted();
      const history = await this.events.read(subject);
      const previous = finalHistory(history);
      const key = communityProgressKey('terminal-observation', subject);
      const raw = incoming || open ? await this.storage.get(key) : null;
      const checkpoint = raw ? checkpointSchema.parse(raw.value) : undefined;
      const state = providerStateEvidence(history);
      const stateMatched = checkpoint?.stateSourceEventId === state?.event.sourceEventId;
      const currentState = state && { ...state,
        observedAt: stateMatched ? checkpoint?.stateObservedAt ?? state.observedAt : state.observedAt,
        updatedAt: stateMatched ? checkpoint?.stateUpdatedAt ?? state.updatedAt : state.updatedAt };
      const reopening = open ? providerOpenEvent(subject, currentState, open) : undefined;
      if (reopening?.denied || !historicalAuthorized && !shouldObserveTerminalFacts(history) && !reopening?.event) return { denied: true, recorded: false };
      if (currentState?.state === 'open' && incoming && observationIsOlder(currentState, {
        ...(incoming.source === 'github-api' ? { observedAt: incoming.observedAt } : {}),
        providerUpdatedAt: incoming.mergedAt ?? incoming.closedAt ?? undefined })) return { denied: true, recorded: false };
      const matched = checkpoint?.sourceEventId === previous.sourceEventId;
      const baseline = previous.facts && { ...previous.facts,
        observedAt: matched ? Math.max(previous.facts.observedAt, checkpoint!.observedAt) : previous.facts.observedAt,
        ci: previous.facts.ci && { ...previous.facts.ci, observedAt: matched
          ? Math.max(previous.facts.ci.observedAt, checkpoint!.ciObservedAt ?? 0) : previous.facts.ci.observedAt } };
      const facts = incoming && mergeTerminalFacts(baseline, mergeTerminalFacts({ ...incoming,
        reviews: terminalReviews([...history, ...batch]) }, parseTerminalFacts(incoming, subject)));
      const observation = facts && (!previous.facts || terminalContent(facts) !== terminalContent(previous.facts))
        ? terminalObservationEvent(facts, previous.sourceEventId) : undefined;
      const rows = [...batch];
      if (reopening?.event) rows.unshift(reopening.event);
      if (observation) {
        const close = rows.findIndex(event => event.kind === 'pr.merged' || event.kind === 'pr.closed');
        rows.splice(close < 0 ? rows.length : close, 0, observation);
      }
      let recorded = false;
      for (const event of rows) {
        this.signal?.throwIfAborted();
        const result = await this.events.append(event);
        if (event === observation) recorded = result.appended;
      }
      const after = providerStateEvidence(await this.events.read(subject));
      const sourceEventId = observation?.sourceEventId ?? previous.sourceEventId ?? after?.event.sourceEventId;
      if ((facts || open && after?.state === 'open') && sourceEventId) {
        this.signal?.throwIfAborted();
        const observedAt = open?.observedAt ?? (incoming?.source === 'github-api' ? incoming.observedAt : undefined);
        const updatedAt = open?.providerUpdatedAt ?? incoming?.mergedAt ?? incoming?.closedAt ?? undefined;
        await this.storage.set(key, { v: 1, sourceEventId,
          observedAt: facts?.observedAt ?? previous.facts?.observedAt ?? checkpoint?.observedAt ?? after!.event.at,
          ciObservedAt: facts?.ci?.observedAt ?? (open ? checkpoint?.ciObservedAt ?? previous.facts?.ci?.observedAt ?? null : null),
          ...(after ? { stateSourceEventId: after.event.sourceEventId,
            ...((observedAt ?? (stateMatched ? checkpoint?.stateObservedAt : after.observedAt)) !== undefined
              ? { stateObservedAt: Math.max(observedAt ?? after.observedAt ?? 0, stateMatched ? checkpoint?.stateObservedAt ?? 0 : 0) } : {}),
            ...((updatedAt ?? currentState?.updatedAt) ? { stateUpdatedAt: updatedAt && (!currentState?.updatedAt || Date.parse(updatedAt) >= Date.parse(currentState.updatedAt)) ? updatedAt : currentState?.updatedAt } : {}),
          } : {}),
        });
      }
      return { denied: false, recorded };
    });
    if (!result.denied) await this.projector.catchUp(subject);
    else await this.projector.resumeFollowUps(subject);
    return result;
  }
}
