import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeIssueDraft, NativeIssueDraftRuntime } from './native-issue-drafts.js';

export type OwnerNativeDrafts = Pick<NativeIssueDraftRuntime, 'create' | 'get' | 'publish' | 'cancel'>;
const content = {
  title: z.string().trim().min(1).max(256),
  bodyMarkdown: z.string().max(65000),
  labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
};
export const ownerDraftEditsSchema = z.object({
  title: content.title.optional(), bodyMarkdown: content.bodyMarkdown.optional(),
}).strict().optional();
const repo = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const explicit = z.object({ ...content, requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), repo }).strict();
const card = z.object({
  ...content, sourceType: z.enum(['cat_initiated', 'frustration_issue']), sourceId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500).optional(), targetRepo: repo,
}).strict();

/** These are explicit owner-selected contents, never imported Host source/confirmation authority. */
export function ownerDraftInput(value: unknown, ownerId: string) {
  const parsed = z.union([explicit, card]).safeParse(value);
  if (!parsed.success) throw new TypeError('Invalid public draft content');
  const input = parsed.data;
  if ('requestId' in input) return input;
  const requestId = 'card:' + createHash('sha256').update(JSON.stringify([
    ownerId, input.sourceType, input.sourceId, input.threadId, input.messageId ?? null,
  ])).digest('hex');
  return { requestId, repo: input.targetRepo, title: input.title, bodyMarkdown: input.bodyMarkdown, labels: input.labels };
}

/** Existing thread cards consume this view; private native storage retains its own identity. */
export function threadDraft(draft: NativeIssueDraft) {
  return {
    draftId: draft.id, title: draft.title, bodyMarkdown: draft.bodyMarkdown, targetRepo: draft.repo,
    labels: draft.labels ?? [], status: draft.status,
    ...(draft.issue ? { githubIssueNumber: draft.issue.number, githubIssueUrl: draft.issue.url } : {}),
  };
}

export async function ownerNativeDraftAction(drafts: OwnerNativeDrafts, id: string,
  action: 'get' | 'publish' | 'cancel', edits?: { title?: string; bodyMarkdown?: string }) {
  try {
    let uncertain = false;
    if (action === 'publish') uncertain = (await drafts.publish({ input: { draftId: id } }, edits)).data.status === 'uncertain';
    if (action === 'cancel') await drafts.cancel({ input: { draftId: id } });
    const draft = threadDraft((await drafts.get({ draftId: id })).data);
    // Existing Host previews equate every 2xx response with published. Keep
    // unknown publication outside that range; retries reconcile the same ID.
    return { status: uncertain ? 409 : 200, body: { draft,
      ...(draft.githubIssueUrl ? { githubIssueUrl: draft.githubIssueUrl } : {}),
      ...(uncertain ? { error: 'Publication outcome uncertain. Retry to look for the original issue without creating another.' } : {}),
    } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Draft operation failed';
    return { status: message.startsWith('native draft not found') ? 404 : error instanceof TypeError ? 400 : 409, body: { error: message } };
  }
}
