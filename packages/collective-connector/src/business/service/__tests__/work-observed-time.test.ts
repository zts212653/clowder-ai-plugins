import { expect, it } from 'vitest';
import { observedWorkTime } from '../work-observed-time.js';

it('recovers the first real progress timestamp from old history without starting on acceptance or changing history', () => {
  const actor = { kind: 'human' as const, humanId: 'owner', displayName: 'Owner' };
  const work = {
    sourceLocation: { channelId: 'general' },
    history: [{ revision: 1, action: 'committed' as const, actor, at: '2026-10-01T00:00:00.000Z' }],
  };
  expect(observedWorkTime(work)).toBeUndefined();
  const started = {
    ...work,
    history: [
      ...work.history,
      {
        revision: 2,
        action: 'progress_reported' as const,
        actor,
        at: '2026-10-02T03:00:00.000Z',
        eventId: 'event-first',
      },
      {
        revision: 3,
        action: 'progress_reported' as const,
        actor,
        at: '2026-10-04T06:00:00.000Z',
        eventId: 'event-second',
      },
    ],
  };
  expect(observedWorkTime(started)?.actualStart).toMatchObject({
    value: '2026-10-02T03:00:00.000Z',
    sourceEventId: 'event-first',
    actor,
  });
  expect('time' in started).toBe(false);
  expect(started.history).toHaveLength(3);
});
