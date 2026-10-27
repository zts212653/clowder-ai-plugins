import type { CollectiveWorkRecord, CollectiveWorkTime } from '../contracts/index.js';

/** Old durable history already records real progress. Reading dates must not invent a later start on upgrade. */
export function observedWorkTime(
  work: Pick<CollectiveWorkRecord, 'time' | 'history' | 'sourceLocation'>,
): CollectiveWorkTime | undefined {
  if (work.time?.actualStart) return work.time;
  const first = work.history.find((entry) => entry.action === 'progress_reported' && entry.eventId);
  if (!first?.eventId) return work.time;
  return {
    ...work.time,
    actualStart: {
      value: first.at,
      timeZone: 'UTC',
      at: first.at,
      actor: first.actor,
      sourceRef: `event:${first.eventId}`,
      sourceEventId: first.eventId,
      sourceLocation: work.sourceLocation,
    },
  };
}
