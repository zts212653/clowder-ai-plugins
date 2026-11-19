import { z } from 'zod';

export type MessageFrom =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent'; readonly catId: string }
  | {
      readonly kind: 'external';
      readonly connectorId: string;
      readonly sender?: { readonly id: string; readonly name?: string };
      readonly address?: { readonly chatId: string; readonly messageId?: string };
    }
  | { readonly kind: 'plugin'; readonly instanceId: string }
  | { readonly kind: 'system'; readonly service: string };

const id = z.string().min(1).max(200);
const version = z.string().min(1).max(300);
/** A matter's selected-segment revision is distinct from a whole message's citation revision. */
export const memoryMessageSelectionSchema = z
  .object({
    segment: z.enum(['body', 'quote_comment', 'quote_text']),
    contentBlockIndex: z.number().int().nonnegative().optional(),
    attachmentId: id.optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    expectedRevision: version,
  })
  .strict();
export type MemoryMessageSelection = z.infer<typeof memoryMessageSelectionSchema>;
export const messageReadRefSchema = z
  .object({
    kind: z.literal('message'),
    messageId: id,
    contextCount: z.number().int().min(0).max(10).optional(),
    threadId: id.optional(),
    expectedRevision: version.optional(),
    sourceSelection: memoryMessageSelectionSchema.optional(),
  })
  .strict();
export const matterReadRefSchema = z
  .object({
    kind: z.literal('matter'),
    matterId: id,
    expectedRevision: z.number().int().positive().optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    history: z.boolean().optional(),
  })
  .strict();

export type ReadRef = z.infer<typeof messageReadRefSchema | typeof matterReadRefSchema>;

export const recallScopeV1Schema = z
  .object({
    ownerUserId: z.string().trim().min(1).max(160),
    threadId: z.string().trim().min(1).max(160),
    invocationId: z.string().trim().min(1).max(160),
  })
  .strict();

export type RecallScopeV1 = z.infer<typeof recallScopeV1Schema>;

const matterId = z.string().trim().min(1).max(200);
const revision = z.number().int().positive();

/** Offsets address raw UTF-16 text, never a normalized search passage. */
export const matterSourceInputSchema = z
  .object({
    threadId: matterId.describe('Exact source thread ID.'),
    messageId: matterId.describe('Exact source message ID in that thread.'),
    segment: z
      .enum(['body', 'quote_comment', 'quote_text'])
      .describe('Raw message body, the quoting author comment, or quoted text; never normalized search text.'),
    contentBlockIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Zero-based contentBlocks index; required for quote segments or multiple text blocks.'),
    attachmentId: matterId.optional().describe('Exact quote attachment ID; required for quote segments.'),
    start: z.number().int().nonnegative().describe('Inclusive raw UTF-16 offset within the selected segment.'),
    end: z.number().int().positive().describe('Exclusive raw UTF-16 offset, greater than start.'),
    quote: z
      .string()
      .min(1)
      .max(8000)
      .describe('Exact selected original text, preserving whitespace; maximum 8000 UTF-16 units.'),
  })
  .strict()
  .refine((source) => source.end > source.start, 'end must follow start');
export type MatterSourceInput = z.infer<typeof matterSourceInputSchema>;

/** A return address, not a claim that a sentence was checked against the original. */
export const matterSourcePointerInputSchema = z
  .object({
    threadId: matterId,
    messageId: matterId.optional(),
  })
  .strict();
export type MatterSourcePointerInput = z.infer<typeof matterSourcePointerInputSchema>;
export const matterWriteSourceInputSchema = z.union([matterSourceInputSchema, matterSourcePointerInputSchema]);
export type MatterWriteSourceInput = z.infer<typeof matterWriteSourceInputSchema>;
const summary = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .optional()
  .describe('Your interpretation, not a verbatim quotation. The authenticated writer is recorded by the server.');
const sources = z
  .array(matterWriteSourceInputSchema)
  .min(1)
  .max(30)
  .optional()
  .describe(
    'Optional thread/message return addresses or exact quotations. If omitted, the server binds this real invocation thread and any confirmed triggering message.',
  );

const writeBase = { requestId: matterId };
const existing = { ...writeBase, matterId, expectedRevision: revision };
export const matterWriteInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...writeBase,
      operation: z.literal('create'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000).default(''),
      summary,
      sources,
    })
    .strict(),
  z.object({ ...existing, operation: z.literal('append'), summary, sources }).strict(),
  z
    .object({
      ...existing,
      operation: z.literal('edit'),
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4000),
    })
    .strict(),
  z
    .object({
      ...existing,
      operation: z.literal('correct'),
      entryId: matterId,
      summary,
      source: matterWriteSourceInputSchema.optional(),
    })
    .strict(),
  z.object({ ...existing, operation: z.literal('retire_entry'), entryId: matterId }).strict(),
  z.object({ ...existing, operation: z.literal('retire') }).strict(),
  z.object({ ...existing, operation: z.literal('forget') }).strict(),
]);
export type MatterWriteInput = z.infer<typeof matterWriteInputSchema>;

export interface MatterSourceCoordinate extends Omit<MatterSourceInput, 'quote'> {
  sourceRevision: string;
  author: MessageFrom;
  timestamp: number;
}
export type MatterSourcePointer =
  | { kind: 'thread'; threadId: string; origin: 'explicit' | 'invocation' }
  | {
      kind: 'message';
      threadId: string;
      messageId: string;
      origin: 'explicit' | 'invocation';
      author: MessageFrom;
      timestamp: number;
      sourceRevision: string;
      contentRevision: string;
    };
export type MatterSourceReference = MatterSourceCoordinate | MatterSourcePointer;
export interface MemoryMatter {
  matterId: string;
  title: string;
  description: string;
  /** Absent on historical records; never infer it from an original message's speaker. */
  descriptionAuthor?: MessageFrom;
  revision: number;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}
export interface MatterEntryView {
  readRef?: ReadRef;
  entryId: string;
  status: 'active' | 'superseded' | 'retired';
  supersededBy?: string;
  source: MatterSourceReference;
  sourceStatus: 'current' | 'changed' | 'thread_only';
  summary?: string;
  summaryAuthor?: MessageFrom;
  recordedAt?: number;
  /** The entry as received; separate from any original-message revision. */
  entryRevision?: string;
  quote?: string;
  /** A quote's outer speaker is not its quoted speaker. */
  attribution: 'author' | 'quoted_in_message';
  verifiedQuotedAuthor?: MessageFrom;
}
export interface MatterPage {
  matter: MemoryMatter;
  entries: MatterEntryView[];
  /** An active original changed; the stored interpretation has not been reverified. */
  summaryStatus?: 'sources_changed';
  nextCursor?: string;
}
export interface MatterCatalogItem extends MemoryMatter {
  readRef?: ReadRef;
  entryCount: number;
  /** A currently readable, active, unchanged source originates in this thread; not applicability. */
  hasThreadSource?: boolean;
  summaryStatus?: 'sources_changed';
}
export interface MatterUnavailableItem {
  matterId: string;
  revision: number;
  unavailable: true;
  status: 'active' | 'retired';
}
export interface MatterCatalog {
  items: Array<MatterCatalogItem | MatterUnavailableItem>;
  nextCursor?: string;
}
export interface MatterMutationReceipt {
  outcome: 'applied' | 'forgotten';
  matter: { matterId: string; revision: number; status: 'active' | 'retired' };
  writeRef?: MatterWriteRef;
}

/** Content-free address of the original durable write receipt, never a live page preview. */
export const matterWriteRefSchema = z
  .object({
    actorKey: matterId,
    requestId: matterId,
    operation: z.enum(['create', 'append', 'edit', 'correct', 'retire_entry', 'retire', 'forget']),
    revision,
  })
  .strict();
export type MatterWriteRef = z.infer<typeof matterWriteRefSchema>;
export interface MatterWriteSnapshot {
  operation: MatterWriteRef['operation'];
  matter: Pick<MemoryMatter, 'matterId' | 'title' | 'revision'>;
  recordedAt: number;
  writer?: MessageFrom;
  titleChange?: { before: string; after: string };
  descriptionChange?: { before: string; after: string; author?: MessageFrom };
  entries: MatterEntryView[];
  previousEntries?: MatterEntryView[];
  /** Current validity warning only; fixed write content is never replaced with today's page. */
  sourcesChanged?: boolean;
}

/** Content-free read evidence; only the matter resolver may carry this shape. */
export const matterReadDetailsSchema = z
  .object({
    matterId,
    pageRevision: revision,
    entries: z
      .array(
        z.union([
          z.object({ entryId: matterId, sourceRevision: matterId }).strict(),
          z.object({ entryId: matterId, entryRevision: matterId }).strict(),
        ]),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type MatterReadDetails = z.infer<typeof matterReadDetailsSchema>;
export type MatterReadSummary =
  | { status: 'current'; matterId: string; title: string; messageCount: number; summaryCount?: number }
  | { status: 'changed'; matterId: string }
  | { status: 'not_available' };

const matterReadOptions = z
  .object({ cursor: z.string().max(2000).optional(), limit: z.number().int().min(1).max(30).optional(),
    history: z.boolean().optional(), expectedRevision: revision.optional() })
  .strict();

export const matterDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('matter.catalog'), input: z.object({
    query: z.string().max(200).optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    management: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ operation: z.literal('matter.read'), input: z.object({
    matterId, options: matterReadOptions,
  }).strict() }).strict(),
  z.object({ operation: z.literal('matter.read_for_invocation'), input: z.object({
    matterId, options: matterReadOptions,
  }).strict() }).strict(),
  z.object({ operation: z.literal('matter.write'), input: matterWriteInputSchema }).strict(),
  z.object({ operation: z.literal('matter.write_snapshot'), input: z.object({
    matterId, ref: matterWriteRefSchema.pick({ actorKey: true, requestId: true }),
  }).strict() }).strict(),
  z.object({ operation: z.literal('matter.select_source'), input: z.object({
    threadId: matterId, messageId: matterId, quote: z.string().min(1).max(8000),
  }).strict() }).strict(),
  z.object({ operation: z.literal('matter.project'), input: z.object({ matterId }).strict() }).strict(),
  z.object({ operation: z.literal('matter.read_receipt'), input: matterReadDetailsSchema }).strict(),
]);

export type MatterDispatchInput = z.infer<typeof matterDispatchSchema>;

export const matterBusinessFailureSchema = z.object({
  status: z.literal('rejected'),
  code: z.enum(['not_available', 'invalid_source', 'stale_revision', 'request_conflict', 'invalid_cursor']),
  detail: z.object({ reason: z.string(), hint: z.string() }).strict().optional(),
}).strict();

const messageAuthor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('agent'), catId: z.string() }),
  z.object({
    kind: z.literal('external'), connectorId: z.string(),
    sender: z.object({ id: z.string(), name: z.string().optional() }).optional(),
    address: z.object({ chatId: z.string(), messageId: z.string().optional() }).optional(),
  }),
  z.object({ kind: z.literal('plugin'), instanceId: z.string() }),
  z.object({ kind: z.literal('system'), service: z.string() }),
]);
const matterStatus = z.enum(['active', 'retired']);
const matterCoordinate = memoryMessageSelectionSchema.omit({ expectedRevision: true }).extend({
  threadId: matterId, messageId: matterId, sourceRevision: z.string(), author: messageAuthor, timestamp: z.number(),
});
const pointerOrigin = z.enum(['explicit', 'invocation']);
const matterEntry = z.object({
  entryId: matterId,
  status: z.enum(['active', 'superseded', 'retired']),
  supersededBy: z.string().optional(),
  readRef: z.discriminatedUnion('kind', [messageReadRefSchema, matterReadRefSchema]).optional(),
  source: z.union([
    z.object({ kind: z.literal('thread'), threadId: matterId, origin: pointerOrigin }),
    z.object({
      kind: z.literal('message'), threadId: matterId, messageId: matterId, origin: pointerOrigin,
      author: messageAuthor, timestamp: z.number(), sourceRevision: z.string(), contentRevision: z.string(),
    }),
    matterCoordinate,
  ]),
  sourceStatus: z.enum(['current', 'changed', 'thread_only']),
  summary: z.string().optional(),
  summaryAuthor: messageAuthor.optional(),
  recordedAt: z.number().optional(),
  entryRevision: z.string().optional(),
  quote: z.string().optional(),
  attribution: z.enum(['author', 'quoted_in_message']),
  verifiedQuotedAuthor: messageAuthor.optional(),
});
const matterIdentity = z.object({ matterId, revision, status: matterStatus });
const matterRecord = matterIdentity.extend({
  title: z.string(), description: z.string(), descriptionAuthor: messageAuthor.optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
const summaryStatus = z.literal('sources_changed').optional();
const matterPage = z.object({
  matter: matterRecord, entries: matterEntry.array(), summaryStatus, nextCursor: z.string().optional(),
});
const matterCatalog = z.object({
  items: z.array(z.union([
    matterIdentity.extend({ unavailable: z.literal(true) }),
    matterRecord.extend({
      readRef: matterReadRefSchema.optional(), entryCount: z.number(), hasThreadSource: z.boolean().optional(), summaryStatus,
    }),
  ])),
  nextCursor: z.string().optional(),
});
const matterWriteSnapshot = z.object({
  operation: matterWriteRefSchema.shape.operation,
  matter: matterRecord.pick({ matterId: true, title: true, revision: true }),
  recordedAt: z.number(),
  writer: messageAuthor.optional(),
  titleChange: z.object({ before: z.string(), after: z.string() }).optional(),
  descriptionChange: z.object({ before: z.string(), after: z.string(), author: messageAuthor.optional() }).optional(),
  entries: matterEntry.array(),
  previousEntries: matterEntry.array().optional(),
  sourcesChanged: z.boolean().optional(),
});

export const matterOutputSchemas = {
  'matter.catalog': matterCatalog,
  'matter.read': matterPage,
  'matter.read_for_invocation': matterPage,
  'matter.write': z.object({
    outcome: z.enum(['applied', 'forgotten']), matter: matterIdentity, writeRef: matterWriteRefSchema.optional(),
  }),
  'matter.write_snapshot': matterWriteSnapshot,
  'matter.select_source': matterSourceInputSchema,
  'matter.project': matterPage.nullable(),
  'matter.read_receipt': z.discriminatedUnion('status', [
    z.object({ status: z.literal('current'), page: matterPage }),
    z.object({ status: z.literal('changed') }),
    z.object({ status: z.literal('not_available') }),
  ]),
} satisfies Record<MatterDispatchInput['operation'], z.ZodType>;
