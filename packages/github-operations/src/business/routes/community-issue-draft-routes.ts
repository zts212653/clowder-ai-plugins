/**
 * F235: Community Issue Draft API routes.
 *
 * GET  .../by-id/:draftId                        — get draft status + content
 * POST .../by-id/:draftId/publish                — user edits + publish to GitHub
 * POST .../by-id/:draftId/cancel                 — cancel draft
 *
 * All routes require a Host-authenticated request context. Client headers are not authority.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ICommunityIssueDraftStore } from '../domains/community/ports/CommunityIssueDraftStore.js';
import type { CommunityIssueDraft } from '../model/index.js';
import { sanitize } from '../domains/community/issue-analysis/CommunityIssueSanitizer.js';
import type { CommunityRequestContext } from './community-request-context.js';
import { ownerDraftInput, ownerDraftEditsSchema, ownerNativeDraftAction, threadDraft, type OwnerNativeDrafts } from '../../owner-issue-drafts.js';

// ── Options ───────────────────────────────────────────────────

export interface CommunityDraftConfig {
  defaultRepo: string;
  repoAllowlist: string[];
}

export interface CommunityIssueDraftRoutesOptions {
  communityIssueDraftStore: ICommunityIssueDraftStore;
  requestContext: CommunityRequestContext;
  nativeDrafts: OwnerNativeDrafts;
  publication: { publish(draft: CommunityIssueDraft): Promise<{ issue?: { number: number; url: string } }> };
  config: CommunityDraftConfig | (() => Promise<CommunityDraftConfig>);
}

// ── Schemas ───────────────────────────────────────────────────

const draftIdParamsSchema = z.object({
  draftId: z.string().min(1).max(200),
});

const publishBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    bodyMarkdown: z.string().trim().min(1).max(10000).optional(),
  })
  .strict()
  .optional();

// ── Routes ────────────────────────────────────────────────────

export const communityIssueDraftRoutes: FastifyPluginAsync<CommunityIssueDraftRoutesOptions> = async (app, opts) => {
  const { communityIssueDraftStore, publication } = opts;
  const currentConfig = async () => {
    await opts.requestContext.assertCurrent();
    const value = typeof opts.config === 'function' ? await opts.config() : opts.config;
    await opts.requestContext.assertCurrent();
    return value;
  };
  const resolveUserId = opts.requestContext.userId.bind(opts.requestContext);
  const resolveStrictUserId = resolveUserId;

  // ── GET /api/community-issue-drafts/config ──
  // Phase B: repo picker configuration for frontend dropdown.
  // Static config and by-id draft routes occupy disjoint path namespaces.

  app.get('/api/community-issue-drafts/config', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }
    const config = await currentConfig();
    return {
      defaultRepo: config.defaultRepo,
      repos: config.repoAllowlist,
    };
  });

  // ── POST /api/community-issue-drafts (generic create) ──
  // Phase B: cat-initiated or future generic source types.

  app.post('/api/community-issue-drafts', async (request, reply) => {
    if (!opts.requestContext.requireOwner(reply)) return;
    await opts.requestContext.assertCurrent();
    try {
      const result = await opts.nativeDrafts.create(ownerDraftInput(request.body, resolveUserId(request)!));
      await opts.requestContext.assertCurrent();
      return { ...result, draft: threadDraft(result.data) };
    } catch (error) {
      await opts.requestContext.assertCurrent();
      return reply.code(error instanceof TypeError ? 400 : 409).send({error: error instanceof Error ? error.message : 'Draft creation failed'});
    }
  });

  // ── GET /api/community-issue-drafts/by-id/:draftId ──

  app.get('/api/community-issue-drafts/by-id/:draftId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    if (/^[a-f0-9]{64}$/.test(paramsParse.data.draftId)) {
      if (!opts.requestContext.requireOwner(reply)) return;
      const result = await ownerNativeDraftAction(opts.nativeDrafts, paramsParse.data.draftId, 'get');
      return reply.code(result.status).send(result.body);
    }
    const draft = await communityIssueDraftStore.getById(paramsParse.data.draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }

    return { draft };
  });

  // ── POST /api/community-issue-drafts/by-id/:draftId/publish ──

  app.post('/api/community-issue-drafts/by-id/:draftId/publish', async (request, reply) => {
    // R8-P1-1: strict identity — publish is an external side effect, no default-user
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { draftId } = paramsParse.data;
    if (/^[a-f0-9]{64}$/.test(draftId)) {
      if (!opts.requestContext.requireOwner(reply)) return;
      const nativeBody = ownerDraftEditsSchema.safeParse(request.body);
      if (!nativeBody.success) return reply.code(400).send({ error: 'Invalid body', details: nativeBody.error.issues });
      const result = await ownerNativeDraftAction(opts.nativeDrafts, draftId, 'publish', nativeBody.data);
      return reply.code(result.status).send(result.body);
    }

    const bodyParse = publishBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid body', details: bodyParse.error.issues };
    }

    const edits = bodyParse.data;

    // Get current draft
    let draft = await communityIssueDraftStore.getById(draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }
    if (draft.status === 'published') return { draft, githubIssueUrl: draft.githubIssueUrl };
    if (draft.status === 'cancelled') return reply.code(409).send({ error: 'Draft cancelled' });
    const config = await currentConfig();
    if (!config.repoAllowlist.includes(draft.targetRepo)) return reply.code(403).send({ error: 'Repository not allowed' });
    const sanitized = sanitize(edits?.title ?? draft.title, edits?.bodyMarkdown ?? draft.bodyMarkdown);
    if (!sanitized.passed) return reply.code(422).send({ error: 'Content contains forbidden patterns' });
    try {
      // This CAS freezes content and prevents cancellation or edits in another
      // process before entering the durable publication journal.
      draft = await communityIssueDraftStore.beginPublish(draftId, sanitized.title, sanitized.bodyMarkdown);
      const result = await publication.publish(draft);
      if (!result.issue) return reply.code(409).send({ draft, error: 'Publication outcome uncertain. Retry reconciles the original issue without creating another.' });
      const published = await communityIssueDraftStore.publish({ draftId, githubIssueNumber: result.issue.number, githubIssueUrl: result.issue.url });
      return { draft: published, githubIssueUrl: result.issue.url };
    } catch (err: unknown) {
      // Preserve publishing on all failures. Never fabricate a persisted
      // published response or roll back to an editable draft after a POST.
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Publication failed; retry to reconcile' });
    }
  });

  // ── POST /api/community-issue-drafts/by-id/:draftId/cancel ──

  app.post('/api/community-issue-drafts/by-id/:draftId/cancel', async (request, reply) => {
    // R8-P1-1 audit: strict identity for all mutations
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { draftId } = paramsParse.data;
    if (/^[a-f0-9]{64}$/.test(draftId)) {
      if (!opts.requestContext.requireOwner(reply)) return;
      const result = await ownerNativeDraftAction(opts.nativeDrafts, draftId, 'cancel');
      return reply.code(result.status).send(result.body);
    }
    const draft = await communityIssueDraftStore.getById(draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }
    if (draft.status !== 'draft') {
      reply.status(409);
      return { error: `Draft is ${draft.status}, cannot cancel` };
    }

    const cancelled = await communityIssueDraftStore.cancel(draftId);
    return { draft: cancelled };
  });
};
