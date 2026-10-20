import { z } from 'zod';
import { collectiveStandingWorkSchema } from './business/contracts/index.js';

/** Package-owned original ca5 route validation. These are caller-supplied,
 * authenticated Host read facts, not grant or Task execution authority. */
export interface CollectiveOwnerRouteOptions {
  readonly isCatAvailable: (catId: string) => boolean;
  readonly supportsParticipation?: (catId: string) => boolean;
  readonly resolveAgentIdentity: (catId: string) => { readonly displayName: string } | undefined;
  readonly threadStore: { get(threadId: string): { readonly id: string; readonly participants: readonly string[]; readonly deletedAt?: number | null } | null |
    Promise<{ readonly id: string; readonly participants: readonly string[];
      readonly deletedAt?: number | null } | null>; };
}

export const hostRouteBodySchema = z
  .object({
    defaultIngressThreadId: z.string().trim().min(1).max(240),
    expectedRevision: z.number().int().nonnegative().optional(),
    humanNotificationThreadId: z.string().trim().min(1).max(240),
    agentRoutes: z.record(
      z.string(),
      z
        .object({
          catId: z.string().trim().min(1).max(120),
          threadId: z.string().trim().min(1).max(240),
          participation: z
            .object({
              displayName: z.string().min(1).max(120),
              channelIds: z.array(z.string().min(1).max(160)).min(1).max(100),
            })
            .strict()
            .optional(),
          standingWork: collectiveStandingWorkSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

export async function validateHostRoute(
  options: CollectiveOwnerRouteOptions,
  ownerUserId: string,
  authorizedHumanId: string,
  route: z.infer<typeof hostRouteBodySchema>,
): Promise<{ error: string; code: string } | undefined> {
  const destinationIds = new Set([route.defaultIngressThreadId, route.humanNotificationThreadId]);
  for (const [targetKey, agentRoute] of Object.entries(route.agentRoutes)) {
    if (!targetKey.startsWith(`${authorizedHumanId}:`)) {
      return { error: 'Agent route target does not belong to the paired Human', code: 'TARGET_NOT_LOCAL' };
    }
    const targetAgentId = targetKey.slice(authorizedHumanId.length + 1);
    if (!targetAgentId) {
      return { error: 'Agent route requires an exact Collective Agent target', code: 'AGENT_ROUTE_MISMATCH' };
    }
    if (!options.isCatAvailable(agentRoute.catId)) {
      return { error: 'Configured Cat is unavailable', code: 'ROUTE_CAT_UNAVAILABLE' };
    }
    if (
      agentRoute.participation &&
      (targetAgentId !== agentRoute.catId ||
        !options.supportsParticipation?.(agentRoute.catId) ||
        agentRoute.participation.displayName !== options.resolveAgentIdentity(agentRoute.catId)?.displayName)
    ) {
      return {
        error: 'Cat cannot enforce this public participation policy or identity',
        code: 'PARTICIPATION_UNSUPPORTED',
      };
    }
    if (agentRoute.standingWork) {
      if (
        !agentRoute.participation ||
        agentRoute.standingWork.channelIds.some((id) => !agentRoute.participation!.channelIds.includes(id))
      ) {
        return { error: 'Standing work exceeds public participation scope', code: 'OWNER_ADMISSION_SCOPE_MISMATCH' };
      }
      if (agentRoute.standingWork.threadId) destinationIds.add(agentRoute.standingWork.threadId);
    }
    destinationIds.add(agentRoute.threadId);
  }
  const threads = new Map<string, Awaited<ReturnType<CollectiveOwnerRouteOptions['threadStore']['get']>>>();
  for (const threadId of destinationIds) {
    const thread = await options.threadStore.get(threadId);
    if (!thread || thread.deletedAt) {
      return { error: 'Configured Thread is unavailable to this owner', code: 'ROUTE_THREAD_UNAVAILABLE' };
    }
    threads.set(threadId, thread);
  }
  for (const agentRoute of Object.values(route.agentRoutes)) {
    if (
      !threads.get(agentRoute.threadId)?.participants.includes(agentRoute.catId) ||
      (agentRoute.standingWork?.threadId &&
        !threads.get(agentRoute.standingWork.threadId)?.participants.includes(agentRoute.catId))
    ) {
      return {
        error: 'Configured Cat is not a participant in the destination Thread',
        code: 'ROUTE_CAT_NOT_IN_THREAD',
      };
    }
  }
  return undefined;
}
