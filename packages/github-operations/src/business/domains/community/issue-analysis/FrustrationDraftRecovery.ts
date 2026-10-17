import { assertFrustrationContract, type FrustrationSource } from '@clowder-ai/plugin-contract';
import type { PluginFrustrationHost } from '@clowder-ai/plugin-sdk';
import type { CommunityIssueDraft } from '../../../model/index.js';
import type { ICommunityIssueDraftStore } from '../ports/CommunityIssueDraftStore.js';
import { createDraftFromFrustrationIssue, type SourceAdapterConfig } from './FrustrationIssueSourceAdapter.js';

export class FrustrationDraftError extends Error {
  constructor(readonly status: number, message: string, readonly draft?: CommunityIssueDraft) { super(message); }
}
interface RecoveryOptions {
  source: PluginFrustrationHost;
  drafts: ICommunityIssueDraftStore;
  config: SourceAdapterConfig;
  assertCurrent(): Promise<void>;
}
function sameSource(draft: CommunityIssueDraft, source: FrustrationSource): boolean {
  return draft.sourceType === 'frustration_issue' && draft.sourceId === source.issueId && draft.userId === source.userId && draft.threadId === source.threadId;
}

/** The private draft CAS and Host navigation-link CAS are separate commits.
 * Reuse the durable draft and its frozen source revision after an uncertain
 * result; never silently rebase its content onto a newer source or link. */
export async function recoverFrustrationDraft(issueId: string, userId: string, options: RecoveryOptions): Promise<CommunityIssueDraft> {
  const { drafts, assertCurrent } = options;
  await assertCurrent();
  const source = await options.source.getSource(issueId);
  await assertCurrent();
  if (!source) throw new FrustrationDraftError(404, 'Frustration issue not found');
  assertFrustrationContract('FrustrationSource', source);
  if (source.issueId !== issueId) throw new FrustrationDraftError(409, 'Source identity changed');
  if (source.userId !== userId) throw new FrustrationDraftError(403, 'Not your issue');
  if (source.status !== 'confirmed') throw new FrustrationDraftError(409, 'Source must be confirmed');
  let draft = await drafts.getBySourceId(issueId);
  if (draft && !sameSource(draft, source)) throw new FrustrationDraftError(409, 'Draft source ownership changed');
  const previousId = source.communityIssueDraftId;
  if (previousId && previousId !== draft?.draftId) {
    const previous = await drafts.getById(previousId);
    if (!previous || !sameSource(previous, source) || previous.status !== 'cancelled') throw new FrustrationDraftError(409, 'Source link does not name a cancelled predecessor');
  }
  if (!draft) {
    if (!options.config.defaultRepo || !options.config.repoAllowlist.includes(options.config.defaultRepo)) throw new FrustrationDraftError(403, 'No allowed repository for source drafts');
    await assertCurrent();
    try { draft = await createDraftFromFrustrationIssue(source, { draftStore: drafts, config: options.config }); }
    catch (error) {
      // CAS may have committed while its response was lost, or another owner
      // request won the same source. Only the durable matching record is reused.
      draft = await drafts.getBySourceId(issueId);
      if (!draft) throw error;
    }
  }
  await assertCurrent();
  if (!sameSource(draft, source)) throw new FrustrationDraftError(409, 'Draft source ownership changed');
  if (draft.status === 'publishing' || draft.status === 'published') {
    // This is navigation recovery, not permission to edit, publish or re-link.
    // Preserve even an older content revision: publication content is immutable.
    if (previousId !== draft.draftId) throw new FrustrationDraftError(409, 'Publication draft is not linked to this source');
    throw new FrustrationDraftError(409, 'Publication draft already exists', draft);
  }
  if (draft.status !== 'draft') throw new FrustrationDraftError(409, 'Draft is not an editable source draft');
  const binding = draft.sourceBinding;
  if (!binding || binding.revision !== source.sourceRevision) throw new FrustrationDraftError(409, 'Source changed; cancel this draft before recreating', draft);
  if (previousId !== draft.draftId && binding.previousDraftId !== previousId) throw new FrustrationDraftError(409, 'Source link changed', draft);
  const input = { issueId, sourceRevision: binding.revision, expectedDraftId: previousId, draftId: draft.draftId };
  await assertCurrent();
  let result;
  try { result = await options.source.linkDraft(input); }
  catch { throw new FrustrationDraftError(502, 'Source link unavailable; retry this draft', draft); }
  await assertCurrent();
  assertFrustrationContract('FrustrationLinkDraftResult', result);
  if (result.outcome !== 'linked' && result.outcome !== 'already_linked') {
    throw new FrustrationDraftError(result.outcome === 'missing' ? 404 : 409, `Source link ${result.outcome}`, draft);
  }
  if (result.draftId !== draft.draftId || result.sourceRevision !== binding.revision) throw new FrustrationDraftError(409, 'Source link receipt mismatch', draft);
  const current = await drafts.getBySourceId(issueId);
  await assertCurrent();
  if (current && current.draftId === draft.draftId && sameSource(current, source)
    && (current.status === 'publishing' || current.status === 'published')) {
    throw new FrustrationDraftError(409, 'Publication draft already exists', current);
  }
  if (!current || current.draftId !== draft.draftId || current.status !== 'draft') throw new FrustrationDraftError(409, 'Draft changed during source linking');
  return current;
}
