import type { Readable } from 'node:stream';

/** The Service authenticates a current Human; the Host delegates byte custody, not its local session. */
export interface CollectiveAttachmentScope {
  serviceInstanceId: string;
  collectiveId: string;
  humanId: string;
  channelId: string;
  attachmentId: string;
}
export interface CollectiveMessageAttachment {
  v: 1;
  attachmentId: string;
  contentRef: string;
  ownerRevision: 1;
  ownerReceiptRef: string;
  blobDigest: string;
  byteLength: number;
  mediaType: string;
  fileName: string;
}
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
