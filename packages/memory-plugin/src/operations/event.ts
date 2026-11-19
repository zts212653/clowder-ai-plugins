import { eventDispatchSchema } from '@clowder-ai/plugin-memory-contract/event';
import type { EventMemoryStore } from '../events/EventMemoryStore.js';

export async function dispatchEvent(
  store: EventMemoryStore,
  source: { caller(): Promise<{ userId: string }>; assertCurrent(): Promise<void> },
  value: unknown,
) {
  const request = eventDispatchSchema.parse(value);
  const { userId: ownerUserId } = await source.caller();
  switch (request.operation) {
    case 'event.get': {
      const event = store.getEvent(request.input.eventId);
      return event?.ownerUserId === ownerUserId ? event : null;
    }
    case 'event.list':
      return store.listEvents({ ...request.input, ownerUserId });
    case 'event.by_coordinate':
      return store.getByCoord(request.input.threadId, request.input.messageId, ownerUserId);
    case 'event.action_evidence':
      return store.getOwnerActionEvidence(request.input.eventId, ownerUserId, request.input.requestId);
    case 'event.mark': {
      await source.assertCurrent();
      try {
        return store.markEvent(request.input, ownerUserId);
      } catch (error) {
        store.appendDeadLetter(request.input, ownerUserId, String(error));
        throw error;
      }
    }
    case 'event.correct':
      await source.assertCurrent();
      return store.correctEvent({ ...request.input, ownerUserId });
    case 'event.retire':
      await source.assertCurrent();
      return store.retireEvent({ ...request.input, ownerUserId });
    case 'event.forget':
      await source.assertCurrent();
      return store.hardForgetEvent({ ...request.input, ownerUserId });
  }
}
