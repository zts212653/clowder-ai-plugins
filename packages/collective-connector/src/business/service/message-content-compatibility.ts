import type { CollectiveEventEnvelope } from '../contracts/index.js';
import type { CollectiveComposerDraft } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';

export const messageContentVersionHeader = 'x-collective-message-content';
export function assertComposerContentReader(content: CollectiveComposerDraft, version: string) {
  if (version !== '2' && (content.richEditor || content.richBlocks?.length || content.voiceDraft || content.contextAttachments?.length || content.attachments?.some(attachment => attachment.sticker)))
    throw new CollectiveServiceError('MESSAGE_CONTENT_UPGRADE_REQUIRED', 'Update this Client to restore this private draft', 409);
}
/** Legacy text remains readable. A client must not silently turn a new content event into an empty message. */
export function assertMessageContentReader(events: readonly CollectiveEventEnvelope[], version: string) {
  if ((!['1', '2'].includes(version) && events.some(event => event.attachments?.length)) ||
      (version !== '2' && events.some(event => event.richBlocks?.length || event.contextAttachments?.length || event.attachments?.some(attachment => attachment.sticker))))
    throw new CollectiveServiceError('MESSAGE_CONTENT_UPGRADE_REQUIRED', 'Update this Client or Connector to read message content', 409);
}
