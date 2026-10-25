import type { CollectiveEventEnvelope } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';

export const messageContentVersionHeader = 'x-collective-message-content';
/** Legacy text remains readable. A client must not silently turn a new content event into an empty message. */
export function assertMessageContentReader(events: readonly CollectiveEventEnvelope[], version: string) {
  if (version !== '1' && events.some(event => event.attachments?.length))
    throw new CollectiveServiceError('MESSAGE_CONTENT_UPGRADE_REQUIRED', 'Update this Client or Connector to read message attachments', 409);
}
