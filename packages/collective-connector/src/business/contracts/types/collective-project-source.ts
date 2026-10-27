import { z } from 'zod';
import { collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';
import { collectiveMaterialItemSchema, collectiveMaterialWitnessSchema } from './collective-material.js';
import { collectiveWorkTimeSchema } from './collective-time.js';
import { collectiveWorkSourceReadRequestSchema } from './collective-work-matter.js';

const id = z.string().min(1).max(200);
export const collectiveProjectSourceRequestSchema = collectiveWorkSourceReadRequestSchema
  .extend({
    materialId: id.optional(),
  })
  .strict();
export const collectiveMaterialSuggestionRequestSchema = collectiveWorkSourceReadRequestSchema
  .extend({
    materialId: id,
    expectedRevision: z.number().int().positive(),
    requestId: id,
    clauseIds: z.array(id).min(1).max(200),
    suggestedWorkId: collectiveWorkIdSchema.optional(),
  })
  .strict();
export const collectiveProjectSourceReadSchema = z
  .object({
    sourceEventId: id,
    projects: z
      .array(z.object({ roadmapId: id, title: z.string(), revision: z.number().int().positive() }).strict())
      .max(12),
    dates: z
      .array(
        z
          .object({
            workId: collectiveWorkIdSchema,
            title: z.string(),
            revision: z.number().int().positive(),
            time: collectiveWorkTimeSchema.optional(),
          })
          .strict(),
      )
      .max(100),
    materials: z
      .array(
        z
          .object({
            materialId: id,
            roadmapId: id,
            revision: z.number().int().positive(),
            title: z.string(),
            sourceRef: z.string(),
            witness: collectiveMaterialWitnessSchema,
            clauseIds: z.array(id),
            material: collectiveMaterialItemSchema.shape.material.optional(),
          })
          .strict(),
      )
      .max(100),
    hasMore: z.boolean(),
    trust: z.literal('untrusted_external'),
    instructionPolicy: z.literal('data_only'),
  })
  .strict();
export type CollectiveProjectSourceRequest = z.infer<typeof collectiveProjectSourceRequestSchema>;
export type CollectiveMaterialSuggestionRequest = z.infer<typeof collectiveMaterialSuggestionRequestSchema>;
