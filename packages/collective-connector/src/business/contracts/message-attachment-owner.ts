import type { Readable } from 'node:stream';

import type { CollectiveAttachmentScope, CollectiveMessageAttachment } from './index.js';

export interface CollectiveAttachmentAuthority {
  reauthorize(): Promise<CollectiveAttachmentScope>;
}
export interface CollectiveMessageAttachmentOwnerPort {
  retain(input: {
    scope: CollectiveAttachmentScope;
    fileName: string;
    mediaType: string;
    blobDigest: string;
    bytes: Uint8Array;
  }, authority: CollectiveAttachmentAuthority, signal: AbortSignal): Promise<CollectiveMessageAttachment>;
  open(input: {
    scope: CollectiveAttachmentScope;
    attachment: CollectiveMessageAttachment;
    range?: string;
  }, authority: CollectiveAttachmentAuthority, signal: AbortSignal): Promise<{
    attachment: CollectiveMessageAttachment;
    status: 200 | 206 | 416;
    start?: number;
    end?: number;
    body: Readable;
  }>;
}
