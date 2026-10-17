/**
 * Community Repo Config Routes (F168 Phase F — F-0)
 *
 * REST API for operator to manage per-repo routing configuration.
 * Each repo can have a guard thread + guard cat assignment.
 *
 * GET    /api/community-repo-configs             → list all configs
 * POST   /api/community-repo-configs             → upsert (create or update by repo)
 * DELETE /api/community-repo-configs/:repo       → delete by repo
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ICommunityRepoConfigStore } from '../domains/community/CommunityRepoConfigStore.js';
import type { CommunityRequestContext } from './community-request-context.js';

export interface CommunityRepoConfigRoutesOptions {
  repoConfigStore: ICommunityRepoConfigStore;
  requestContext: CommunityRequestContext;
}

const repoConfigInputSchema = z.object({
  repo: z.string().min(1),
  guardThreadId: z.string().min(1),
  guardCatId: z.string().min(1),
  reviewMode: z.enum(['observe_only', 'maintainer_review']).optional(),
  cloudReviewPolicy: z.enum(['optional', 'required']).optional(),
});

export const communityRepoConfigRoutes: FastifyPluginAsync<CommunityRepoConfigRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { repoConfigStore } = opts;

  // GET /api/community-repo-configs — list all
  fastify.get('/api/community-repo-configs', async (req, reply) => {
    if (!opts.requestContext.requireOwner(reply)) return;

    const configs = await repoConfigStore.listAll();
    return reply.send(configs);
  });

  // POST /api/community-repo-configs — upsert by repo
  fastify.post('/api/community-repo-configs', async (req, reply) => {
    if (!opts.requestContext.requireOwner(reply)) return;

    const parsed = repoConfigInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid repo config', details: parsed.error.issues });

    const config = await repoConfigStore.upsert(parsed.data);
    return reply.send(config);
  });

  // DELETE /api/community-repo-configs/:repo — delete by repo
  fastify.delete<{ Params: { repo: string } }>('/api/community-repo-configs/:repo', async (req, reply) => {
    if (!opts.requestContext.requireOwner(reply)) return;

    const repo = decodeURIComponent(req.params.repo);
    const deleted = await repoConfigStore.deleteByRepo(repo);
    if (!deleted) {
      return reply.code(404).send({ error: 'Repo config not found' });
    }
    return reply.send({ deleted: true });
  });
};
