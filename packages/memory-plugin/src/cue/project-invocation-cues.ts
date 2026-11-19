import type { MemoryCueInvocationEntry } from '@clowder-ai/plugin-memory-contract/recall';
import type { MemoryCueEvent, MemoryCueInvalidationReason } from './MemoryCueEpisodeStore.js';

/**
 * F321 Phase A (A1): per-cue read projection for one invocation.
 *
 * Status semantics follow the Phase A design table — silence is never
 * reported as refusal: a cue with only `presented` is `presented_unreported`,
 * and `drilled` without a terminal outcome is `drilled` ("看过").
 */
export function projectInvocationCues(events: readonly MemoryCueEvent[]): MemoryCueInvocationEntry[] {
  const byCueId = new Map<string, MemoryCueEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([
      event.scope.ownerUserId,
      event.scope.threadId,
      event.scope.invocationId,
      event.consumerCatId,
      event.cueId,
      event.sourceRevision,
    ]);
    const list = byCueId.get(key);
    if (list) list.push(event);
    else byCueId.set(key, [event]);
  }

  const entries: MemoryCueInvocationEntry[] = [];
  for (const cueEvents of byCueId.values()) {
    const first = cueEvents[0];
    if (!first) continue;

    let presentedAt: number | null = null;
    let lastEventAt = 0;
    let latestTerminal: MemoryCueEvent | null = null;
    let drilled = false;
    let latestInvalidation: MemoryCueEvent | null = null;

    for (const event of cueEvents) {
      if (event.occurredAt > lastEventAt) lastEventAt = event.occurredAt;
      if (event.axis === 'consumption') {
        if (event.consumptionOutcome === 'presented' && (presentedAt === null || event.occurredAt < presentedAt)) {
          presentedAt = event.occurredAt;
        }
        if (event.consumptionOutcome === 'drilled') drilled = true;
        if (
          (event.consumptionOutcome === 'applied' || event.consumptionOutcome === 'dismissed') &&
          (!latestTerminal || event.occurredAt >= latestTerminal.occurredAt)
        ) {
          latestTerminal = event;
        }
      } else if (!latestInvalidation || event.occurredAt >= latestInvalidation.occurredAt) {
        latestInvalidation = event;
      }
    }

    let status: MemoryCueInvocationEntry['status'];
    let invalidationReason: MemoryCueInvalidationReason | null = null;
    if (latestInvalidation) {
      status = 'invalidated';
      invalidationReason = latestInvalidation.invalidationReason;
    } else if (latestTerminal?.consumptionOutcome === 'applied') {
      status = 'applied';
    } else if (latestTerminal?.consumptionOutcome === 'dismissed') {
      status = 'dismissed';
    } else if (drilled) {
      status = 'drilled';
    } else {
      status = 'presented_unreported';
    }

    entries.push({
      cueId: first.cueId,
      resolverFamily: first.resolverFamily,
      sourceAnchor: first.sourceAnchor,
      sourceRevision: first.sourceRevision,
      consumerCatId: first.consumerCatId,
      ...(first.readOrigin === 'explicit_read' ? { source: 'pull' as const } : {}),
      ...(first.readDetails
        ? {
            readDetails: {
              ...first.readDetails,
              entries: [
                ...new Map(
                  cueEvents
                    .filter((event) => event.axis === 'consumption' && event.consumptionOutcome === 'drilled')
                    .flatMap((event) => event.readDetails?.entries ?? [])
                    .map((entry) => [JSON.stringify(entry), entry]),
                ).values(),
              ].sort(
                (a, b) => a.entryId.localeCompare(b.entryId) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
              ),
            },
          }
        : {}),
      ...(first.resolverFamily === 'profile' &&
      (first.sourceAnchor === 'profile:opening-capsule' || first.sourceAnchor.startsWith('profile:opening-primer:'))
        ? { pushSurface: 'profile_opening' as const }
        : {}),
      status,
      invalidationReason,
      presentedAt: presentedAt ?? first.occurredAt,
      lastEventAt,
    });
  }

  entries.sort((a, b) => a.presentedAt - b.presentedAt || a.cueId.localeCompare(b.cueId));
  return entries;
}
