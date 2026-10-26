import { z } from 'zod';
import { collectiveAttachmentScopeSchema, collectiveMessageAttachmentSchema } from '../contracts/index.js';

export const messageAttachmentRecordSchema = z.object({
  scope: collectiveAttachmentScopeSchema,
  clientUploadId: z.string().trim().min(1).max(200),
  membershipRevision: z.number().int().positive(),
  fileName: collectiveMessageAttachmentSchema.shape.fileName,
  mediaType: collectiveMessageAttachmentSchema.shape.mediaType,
  blobDigest: collectiveMessageAttachmentSchema.shape.blobDigest,
  byteLength: collectiveMessageAttachmentSchema.shape.byteLength,
  sticker: collectiveMessageAttachmentSchema.shape.sticker,
  attachment: collectiveMessageAttachmentSchema.optional(),
  publishedEventIds: z.array(z.string()),
  createdAt: z.string().datetime(),
}).strict();
export type MessageAttachmentRecord = z.infer<typeof messageAttachmentRecordSchema>;
