import { z } from 'zod';
import {
  collectiveEventIdSchema,
  collectiveIdSchema,
  collectiveConnectionIdSchema,
  collectiveEndpointIdSchema,
  collectiveHumanActorSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
  collectiveServiceInstanceIdSchema,
} from './collective.js';
import { collectiveArtifactRecordSchema } from './collective-artifact.js';
import { collectiveWorkLifecycleSchema, collectiveWorkStatusSchema } from './collective-collaboration.js';
import { collectiveRoadmapIdSchema, collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

/** Public membership, not live presence or a Host execution/credential projection. */
export const collectiveMemberDirectorySchema = z
  .object({
    humans: z.array(
      collectiveHumanActorSchema
        .omit({ kind: true })
        .extend({ role: z.enum(['steward', 'member']) })
        .strict(),
    ),
    cafes: z.array(
      z
        .object({
          connectionId: collectiveConnectionIdSchema,
          endpointId: collectiveEndpointIdSchema,
          endpointLabel: z.string().min(1).max(160),
          humanId: collectiveHumanIdSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type CollectiveMemberDirectory = z.infer<typeof collectiveMemberDirectorySchema>;

const leaveResponsibilitySourceSchema = z
  .object({
    eventId: collectiveEventIdSchema,
    location: collectiveLocationSchema,
  })
  .strict();

const leaveRoadmapResponsibilitySchema = z
  .object({
    roadmapId: collectiveRoadmapIdSchema,
    title: z.string().trim().min(1).max(200),
    source: leaveResponsibilitySourceSchema,
  })
  .strict();

const leaveWorkResponsibilitySchema = z
  .object({
    workId: collectiveWorkIdSchema,
    title: z.string().trim().min(1).max(200),
    lifecycle: collectiveWorkLifecycleSchema,
    status: collectiveWorkStatusSchema,
    source: leaveResponsibilitySourceSchema,
    projects: z.array(leaveRoadmapResponsibilitySchema).max(100),
  })
  .strict();

const leaveArtifactResponsibilitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('artifact'),
      artifactId: z.string().trim().min(1).max(256),
      title: z.string().trim().min(1).max(200),
      mediaType: collectiveArtifactRecordSchema.shape.mediaType,
      ownerRevision: z.number().int().positive().safe(),
      source: leaveResponsibilitySourceSchema,
      workId: collectiveWorkIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('publication'),
      publicationId: z.string().trim().min(1).max(256),
      title: z.string().trim().min(1).max(200),
      source: leaveResponsibilitySourceSchema,
      workId: collectiveWorkIdSchema.optional(),
    })
    .strict(),
]);

/** Authenticated read model only. The leave transaction independently recomputes the same projection. */
export const collectiveMembershipLeaveReadinessSchema = z
  .object({
    serviceInstanceId: collectiveServiceInstanceIdSchema,
    collectiveId: collectiveIdSchema,
    role: z.enum(['steward', 'member']),
    membershipRevision: z.number().int().positive(),
    governanceHandoffRequired: z.boolean(),
    canLeave: z.boolean(),
    responsibilities: z
      .object({
        works: z.array(leaveWorkResponsibilitySchema).max(10_000),
        roadmaps: z.array(leaveRoadmapResponsibilitySchema).max(10_000),
        artifacts: z
          .object({
            items: z.array(leaveArtifactResponsibilitySchema).max(10_000),
            inaccessibleCount: z.number().int().nonnegative().max(10_000),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type CollectiveMembershipLeaveReadiness = z.infer<typeof collectiveMembershipLeaveReadinessSchema>;
