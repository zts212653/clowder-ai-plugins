import type { Readable } from 'node:stream';

import type {
  CollectiveAttachmentScope,
  CollectiveMessageAttachment,
  CollectiveStickerScope,
  MessageSticker,
} from './index.js';
import type { CollectiveModelImage } from './types/collective-model-content.js';
import type { CollectiveContextAttachmentSelection, CollectiveModelContent } from './types/collective-model-media.js';

export interface CollectiveAttachmentAuthority {
  reauthorize(): Promise<CollectiveAttachmentScope>;
}
export interface CollectiveMessageAttachmentOwnerPort {
  modelContent?(
    input: {
      scope: CollectiveAttachmentScope;
      attachment: CollectiveMessageAttachment;
      selection: CollectiveContextAttachmentSelection;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveModelContent>;
  catalogImage?(
    input: { scope: CollectiveStickerScope; stickerId: string },
    authority: { reauthorize(): Promise<CollectiveStickerScope> },
    signal: AbortSignal,
  ): Promise<{ sticker: MessageSticker; body: Readable }>;
  modelImage?(
    input: {
      scope: CollectiveAttachmentScope;
      attachment: CollectiveMessageAttachment;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveModelImage>;
  retain(
    input: {
      scope: CollectiveAttachmentScope;
      fileName: string;
      mediaType: string;
      blobDigest: string;
      bytes: Uint8Array;
      sticker?: MessageSticker;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<CollectiveMessageAttachment>;
  open(
    input: {
      scope: CollectiveAttachmentScope;
      attachment: CollectiveMessageAttachment;
      range?: string;
    },
    authority: CollectiveAttachmentAuthority,
    signal: AbortSignal,
  ): Promise<{
    attachment: CollectiveMessageAttachment;
    status: 200 | 206 | 416;
    start?: number;
    end?: number;
    body: Readable;
  }>;
}
