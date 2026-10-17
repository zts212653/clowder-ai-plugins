/**
 * F235: Community Issue Draft API routes.
 *
 * POST .../from-frustration-issue/:issueId — create draft from confirmed issue
 * GET  .../by-id/:draftId                        — get draft status + content
 * POST .../by-id/:draftId/publish                — user edits + publish to GitHub
 * POST .../by-id/:draftId/cancel                 — cancel draft
 *
 * All routes require a Host-authenticated request context. Client headers are not authority.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ICommunityIssueDraftStore } from '../domains/community/ports/CommunityIssueDraftStore.js';
import type { PluginFrustrationHost } from '@clowder-ai/plugin-sdk';
import { recoverFrustrationDraft, FrustrationDraftError } from '../domains/community/issue-analysis/FrustrationDraftRecovery.js';
import type { CommunityIssueDraft } from '../model/index.js';
import { sanitize } from '../domains/community/issue-analysis/CommunityIssueSanitizer.js';
import type { CommunityRequestContext } from './community-request-context.js';

// ── Options ───────────────────────────────────────────────────

export interface CommunityDraftConfig {
  defaultRepo: string;
  repoAllowlist: string[];
}

export interface CommunityIssueDraftRoutesOptions {
  communityIssueDraftStore: ICommunityIssueDraftStore;
  frustration: PluginFrustrationHost;
  requestContext: CommunityRequestContext;
  publication: { publish(draft: CommunityIssueDraft): Promise<{ issue?: { number: number; url: string } }> };
  config: CommunityDraftConfig | (() => Promise<CommunityDraftConfig>);
}

// ── Schemas ───────────────────────────────────────────────────

const issueIdParamsSchema = z.object({
  issueId: z.string().min(1).max(200),
});

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

// Phase B: generic draft creation (cat_initiated or future source types)
const genericCreateBodySchema = z.object({
  sourceType: z.enum(['cat_initiated']),
  sourceId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  bodyMarkdown: z.string().trim().min(1).max(10000),
  targetRepo: z.string().max(200).optional(),
  labels: z.array(z.string().max(50)).max(10).optional(),
  threadId: z.string().min(1).max(200),
  // R2 P1 fix: messageId disambiguates same-user cross-thread collisions.
  // Without it, two draft cards with same block.id in different messages collide.
  messageId: z.string().min(1).max(200).optional(),
});

// ── Routes ────────────────────────────────────────────────────

export const communityIssueDraftRoutes: FastifyPluginAsync<CommunityIssueDraftRoutesOptions> = async (app, opts) => {
  const { communityIssueDraftStore, frustration, publication } = opts;
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
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const bodyParse = genericCreateBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid body', details: bodyParse.error.issues };
    }

    const { sourceType, sourceId, title, bodyMarkdown, labels, threadId, messageId } = bodyParse.data;
    const config = await currentConfig();
    const targetRepo = bodyParse.data.targetRepo ?? config.defaultRepo;

    // INV-B2: repo must be in allowlist (server-side enforcement)
    if (!config.repoAllowlist.includes(targetRepo)) {
      reply.status(400);
      return { error: `Repository not allowed: ${targetRepo}` };
    }

    // R1 P1-2 + R2 P1 fix: scope sourceId by (sourceType, userId, messageId) to
    // prevent both cross-user and same-user cross-thread collisions.
    // block.id is per-message sequential, not globally unique. messageId
    // disambiguates cards with the same block.id in different messages.
    const scopedSourceId = `${sourceType}:${userId}:${messageId ?? sourceId}:${sourceId}`;

    // R1 P1-1 fix: idempotent create — if an active draft already exists for
    // this scoped sourceId, return it instead of throwing INV-3. This makes
    // retry-after-failed-publish safe (frontend does create→publish every submit).
    const existing = await communityIssueDraftStore.getBySourceId(scopedSourceId);
    if (existing && (existing.status === 'draft' || existing.status === 'publishing')) {
      return { draft: existing };
    }
    // Cloud P2-1 fix: if the draft was already published, return 409 with
    // the published draft info instead of falling through to create() which
    // would hit INV-3 and surface a 500. This handles page-reload-after-publish.
    if (existing && existing.status === 'published') {
      reply.status(409);
      return { error: 'Already published', draft: existing };
    }

    // Sanitize content on creation (KD-4: defense in depth)
    const sanitized = sanitize(title, bodyMarkdown);
    if (!sanitized.passed) {
      reply.status(422);
      return { error: 'Content contains forbidden patterns that could not be fully redacted' };
    }

    // Create draft via store (store calls shared factory + persists).
    // Cloud P2-5 fix: wrap in try/catch for concurrent create race. In Redis,
    // two tabs can both pass getBySourceId preflight, then one wins SET NX and
    // the loser throws INV-3. Catch and re-read the winner's draft (same pattern
    // as Phase A's from-frustration-issue route).
    try {
      const stored = await communityIssueDraftStore.create({
        sourceType,
        sourceId: scopedSourceId,
        title: sanitized.title,
        bodyMarkdown: sanitized.bodyMarkdown,
        targetRepo,
        labels: labels ?? [],
        threadId,
        userId,
      });
      return { draft: stored };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already has')) {
        // Concurrent race: another request claimed the source slot.
        // Re-read the winner's draft for idempotent recovery.
        const winner = await communityIssueDraftStore.getBySourceId(scopedSourceId);
        if (winner) return { draft: winner };
      }
      reply.status(500);
      return { error: msg };
    }
  });

  // ── POST /api/community-issue-drafts/from-frustration-issue/:issueId ──

  app.post('/api/community-issue-drafts/from-frustration-issue/:issueId', async (request, reply) => {
    // R8-P1-1 audit: strict identity for all mutations (no default-user fallback)
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = issueIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { issueId } = paramsParse.data;

    if (!opts.requestContext.requireOwner(reply)) return;
    try {
      const draft = await recoverFrustrationDraft(issueId, userId, {
        source: frustration, drafts: communityIssueDraftStore, config: await currentConfig(),
        assertCurrent: () => opts.requestContext.assertCurrent(),
      });
      return { draft };
    } catch (error) {
      if (error instanceof FrustrationDraftError) return reply.code(error.status).send({ error: error.message, ...(error.draft ? { draft: error.draft } : {}) });
      throw error;
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

    const bodyParse = publishBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid body', details: bodyParse.error.issues };
    }

    const { draftId } = paramsParse.data;
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
      if (!result.issue) return reply.code(202).send({ draft, warning: 'Publication outcome uncertain. Retry reconciles the original issue without creating another.' });
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
