import { z } from 'zod';

/** Separate owner opt-in; public participation never implies private execution. */
export const collectiveStandingWorkSchema = z
  .object({
    /** Legacy persisted address; authorization no longer selects an execution Thread. */
    threadId: z.string().min(1).max(240).optional(),
    requestingHumanIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    channelIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type CollectiveStandingWork = z.infer<typeof collectiveStandingWorkSchema>;
