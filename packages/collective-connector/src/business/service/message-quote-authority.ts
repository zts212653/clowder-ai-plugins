import type { CollectiveMessageQuote } from '../contracts/index.js';
import { provenEventLocation } from './event-location.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

/** A quote publishes the author's selected excerpt. Its source is a readable public event,
 * never authority to fetch private Thread, file, or another Collective's material. */
export function validateMessageQuotes(state: ServiceState, input: {
  serviceInstanceId: string; collectiveId: string; contextAttachments?: readonly CollectiveMessageQuote[];
}) {
  const events = state.events[input.collectiveId] ?? [];
  for (const quote of input.contextAttachments ?? []) {
    const source = quote.source;
    const event = source.kind === 'collective_message' ? events.find(item => item.eventId === source.eventId) : undefined;
    if (source.kind !== 'collective_message' || source.serviceInstanceId !== input.serviceInstanceId ||
        source.collectiveId !== input.collectiveId || !event || provenEventLocation(events, event)?.channelId !== source.channelId)
      throw new CollectiveServiceError('QUOTE_SOURCE_UNAVAILABLE', 'Quoted source is not a public message in this Collective', 403);
  }
}
