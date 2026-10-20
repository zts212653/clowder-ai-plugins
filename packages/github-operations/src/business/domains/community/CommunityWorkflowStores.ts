import { createHash, randomUUID } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { narratorDeliverySchema } from './narrator/SdkNarratorDelivery.js';
import type { CommunityIssueItem, CreateCommunityIssueInput, UpdateCommunityIssueInput, CommunityIssueDraft, CreateCommunityIssueDraftInput } from '../../model/index.js';
import type { ICommunityIssueStore } from './ports/CommunityIssueStore.js';
import type { CommunityPrItem, CreateCommunityPrInput, UpdateCommunityPrInput, ICommunityPrStore } from './ports/CommunityPrStore.js';
import type { ICommunityIssueDraftStore, PublishDraftInput } from './ports/CommunityIssueDraftStore.js';

const text = z.string().min(1);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).transform(value => value.toLowerCase());
const number = z.number().int().positive().safe();
const timestamp = z.number().int().nonnegative().safe();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const subjectId = (kind: string, repository: string, n: number) => hash(`${kind}:${repository.toLowerCase()}#${n}`);
const issueCreate = z.object({ repo, issueNumber: number, issueType: z.enum(['bug', 'feature', 'enhancement', 'question']), title: text }).strict();
const checklist = z.object({ id: text, label: text, required: z.boolean(), evidence: z.string().optional(), verifiedAt: timestamp.optional(), verifiedBy: text.optional() }).strict();
const issueMutable = z.object({
  narratorDelivery: narratorDeliverySchema.nullable().optional(),
  issueType: issueCreate.shape.issueType, title: text,
  state: z.enum(['unreplied', 'discussing', 'pending-decision', 'accepted', 'declined', 'closed']),
  replyState: z.enum(['unreplied', 'replied']), consensusState: z.enum(['discussing', 'consensus-reached', 'stalled']).optional(),
  assignedThreadId: text.nullable(), assignedCatId: text.nullable(), linkedPrNumbers: z.array(number),
  directionCard: z.record(z.unknown()).nullable(), ownerDecision: z.enum(['accepted', 'declined']).nullable(), relatedFeature: text.nullable(),
  guardianAssignment: z.object({ guardianCatId: text, signoffTokenHash: text, requestedAt: timestamp, requestedBy: text, signedOff: z.boolean(), signedOffAt: timestamp.optional(), approved: z.boolean().optional(), reason: z.string().optional(), checklist: z.array(checklist) }).strict().nullable(),
  lastActivity: z.object({ at: timestamp, event: text }).strict(),
  routeAcceptance: z.enum(['pending', 'accepted', 'rejected']).nullable().optional(), routeSource: z.enum(['auto', 'manual', 'backfill']).nullable().optional(),
}).strict();
const issueSchema = issueMutable.extend({ id: text, repo, issueNumber: number, createdAt: timestamp, updatedAt: timestamp }).strict();
const prCreate = z.object({ repo, prNumber: number, title: text, author: text, state: z.enum(['open', 'merged', 'closed']), replyState: z.enum(['unreplied', 'replied', 'has-new-activity']), headSha: z.string(), draft: z.boolean() }).strict();
const prSchema = prCreate.extend({ id: text, lastReviewedSha: z.string().nullable(), createdAt: timestamp, updatedAt: timestamp }).strict();
const prUpdate = prSchema.pick({ title: true, state: true, replyState: true, headSha: true, lastReviewedSha: true, draft: true }).partial().strict();

/** Whole Community workflow state lives in plugin-private storage. The old
 * provider-only observation namespace remains separate; it cannot mint route,
 * owner or signoff decisions during import. All updates use storage revisions. */
class SubjectRecords<T extends { id: string; repo: string; updatedAt: number }> {
  constructor(private readonly storage: PluginStorageHost, private readonly prefix: string, private readonly decode: (value: unknown) => T) {}
  async create(item: T): Promise<T | null> {
    const value = this.decode(item);
    return (await this.storage.compareAndSet(this.prefix + value.id, null, value)).applied ? value : null;
  }
  async get(id: string): Promise<T | null> {
    const entry = await this.storage.get(this.prefix + id);
    if (!entry) return null;
    const item = this.decode(entry.value);
    if (item.id !== id) throw new Error('Community record identity mismatch');
    return item;
  }
  async listAll(): Promise<T[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(this.prefix)).map(([key, entry]) => {
      const item = this.decode(entry.value);
      if (key !== this.prefix + item.id) throw new Error('Community record identity mismatch');
      return item;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async listByRepo(repository: string): Promise<T[]> { return (await this.listAll()).filter(item => item.repo === repository.toLowerCase()); }
  async update(id: string, patch: Partial<T>, accepts: (previous: T) => boolean = () => true): Promise<T | null> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(this.prefix + id);
      if (!entry) return null;
      const previous = this.decode(entry.value);
      if (previous.id !== id) throw new Error('Community record identity mismatch');
      if (!accepts(previous)) return null;
      const updated = this.decode({ ...previous, ...patch, updatedAt: Date.now() });
      if ((await this.storage.compareAndSet(this.prefix + id, entry.revision, updated)).applied) return updated;
    }
    throw new Error('Community record changed concurrently');
  }
  async delete(id: string): Promise<boolean> {
    const entry = await this.storage.get(this.prefix + id);
    if (!entry) return false;
    return (await this.storage.delete(this.prefix + id, entry.revision)).deleted;
  }
}

export class SdkCommunityWorkflowIssueStore implements ICommunityIssueStore {
  private readonly records: SubjectRecords<CommunityIssueItem>;
  constructor(storage: PluginStorageHost) {
    this.records = new SubjectRecords(storage, 'community.workflow.issue.', value => {
      const item = issueSchema.parse(value);
      if (item.id !== subjectId('issue', item.repo, item.issueNumber)) throw new Error('Community issue identity mismatch');
      return item;
    });
  }
  create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    const parsed = issueCreate.parse(input); const now = Date.now();
    return this.records.create({ ...parsed, id: subjectId('issue', parsed.repo, parsed.issueNumber), state: 'unreplied', replyState: 'unreplied', assignedThreadId: null, assignedCatId: null, linkedPrNumbers: [], directionCard: null, ownerDecision: null, relatedFeature: null, guardianAssignment: null, lastActivity: { at: now, event: 'created' }, createdAt: now, updatedAt: now });
  }
  get(id: string) { return this.records.get(id); }
  getByRepoAndNumber(repository: string, n: number) { return this.get(subjectId('issue', repository, n)); }
  listAll() { return this.records.listAll(); }
  listByRepo(repository: string) { return this.records.listByRepo(repository); }
  async update(id: string, input: UpdateCommunityIssueInput, expectedState?: CommunityIssueItem['state']) { return this.records.update(id, issueMutable.partial().parse(input), previous => expectedState === undefined || previous.state === expectedState); }
  delete(id: string) { return this.records.delete(id); }
}

export class SdkCommunityPrStore implements ICommunityPrStore {
  private readonly records: SubjectRecords<CommunityPrItem>;
  constructor(storage: PluginStorageHost) {
    this.records = new SubjectRecords(storage, 'community.workflow.pr.', value => {
      const item = prSchema.parse(value);
      if (item.id !== subjectId('pr', item.repo, item.prNumber)) throw new Error('Community PR identity mismatch');
      return item;
    });
  }
  create(input: CreateCommunityPrInput): Promise<CommunityPrItem | null> {
    const parsed = prCreate.parse(input); const now = Date.now();
    return this.records.create({ ...parsed, id: subjectId('pr', parsed.repo, parsed.prNumber), lastReviewedSha: null, createdAt: now, updatedAt: now });
  }
  get(id: string) { return this.records.get(id); }
  getByRepoAndNumber(repository: string, n: number) { return this.get(subjectId('pr', repository, n)); }
  listAll() { return this.records.listAll(); }
  listByRepo(repository: string) { return this.records.listByRepo(repository); }
  async update(id: string, input: UpdateCommunityPrInput) { return this.records.update(id, prUpdate.parse(input)); }
  delete(id: string) { return this.records.delete(id); }
}

const draftCreate = z.object({ sourceType: z.enum(['frustration_issue', 'cat_initiated']), sourceId: text, sourceBinding: z.object({ revision: text, previousDraftId: text.nullable() }).strict().optional(), title: text, bodyMarkdown: z.string(), targetRepo: repo, labels: z.array(text), threadId: text, userId: text }).strict();
const draftSchema = draftCreate.extend({ draftId: text, status: z.enum(['draft', 'publishing', 'published', 'cancelled']), githubIssueNumber: number.optional(), githubIssueUrl: z.string().url().optional(), createdAt: timestamp, publishedAt: timestamp.optional(), cancelledAt: timestamp.optional() }).strict().superRefine((draft, context) => {
  if (draft.sourceBinding && draft.sourceType !== 'frustration_issue') context.addIssue({ code: 'custom', message: 'Source binding requires frustration source' });
  const published = draft.githubIssueNumber !== undefined && draft.githubIssueUrl !== undefined && draft.publishedAt !== undefined;
  const hasPublication = draft.githubIssueNumber !== undefined || draft.githubIssueUrl !== undefined || draft.publishedAt !== undefined;
  if (draft.status === 'published' && (!published || draft.cancelledAt !== undefined)) context.addIssue({ code: 'custom', message: 'Published draft requires complete publication result' });
  if (draft.status !== 'published' && hasPublication) context.addIssue({ code: 'custom', message: 'Unpublished draft cannot contain publication result' });
  if ((draft.status === 'cancelled') !== (draft.cancelledAt !== undefined)) context.addIssue({ code: 'custom', message: 'Cancelled draft requires matching cancellation time' });
});
const draftSourceSchema = z.object({ sourceId: text, activeId: text.nullable(), drafts: z.record(draftSchema) }).strict();
type DraftSource = z.infer<typeof draftSourceSchema>;
const draftPrefix = 'community.workflow.draft-source.';

/** Source reservation and all of its draft records commit in ONE CAS. A crash
 * cannot strand a source index or create a second active draft. Cancelled
 * history is retained indefinitely, including after a new draft is created. */
export class SdkCommunityIssueDraftStore implements ICommunityIssueDraftStore {
  constructor(private readonly storage: PluginStorageHost) {}
  private decode(value: unknown, sourceHash: string): DraftSource {
    const state = draftSourceSchema.parse(value);
    if (hash(state.sourceId) !== sourceHash) throw new Error('Draft source identity mismatch');
    const active: string[] = [];
    for (const [id, draft] of Object.entries(state.drafts)) {
      if (draft.draftId !== id || draft.sourceId !== state.sourceId || this.sourceHash(id) !== sourceHash) throw new Error('Draft identity mismatch');
      if (draft.status !== 'cancelled') active.push(id);
    }
    if (active.length > 1 || (active[0] ?? null) !== state.activeId) throw new Error('Draft active reservation mismatch');
    return state;
  }
  private sourceHash(id: string): string {
    const match = /^cid_([a-f0-9]{64})_[a-f0-9-]{36}$/.exec(id);
    if (!match) throw new Error('Invalid draft ID');
    return match[1]!;
  }
  async create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft> {
    const parsed = draftCreate.parse(input); const sourceHash = hash(parsed.sourceId); const key = draftPrefix + sourceHash;
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(key);
      const state = entry ? this.decode(entry.value, sourceHash) : { sourceId: parsed.sourceId, activeId: null, drafts: {} };
      if (state.activeId) throw new Error(`Source ${parsed.sourceId} already has an active draft`);
      const draft = draftSchema.parse({ ...parsed, draftId: `cid_${sourceHash}_${randomUUID()}`, status: 'draft', createdAt: Date.now() });
      const next = { ...state, activeId: draft.draftId, drafts: { ...state.drafts, [draft.draftId]: draft } };
      if ((await this.storage.compareAndSet(key, entry?.revision ?? null, next)).applied) return draft;
    }
    throw new Error('Draft source changed concurrently');
  }
  async getById(id: string): Promise<CommunityIssueDraft | null> {
    const sourceHash = this.sourceHash(id); const entry = await this.storage.get(draftPrefix + sourceHash);
    return entry ? this.decode(entry.value, sourceHash).drafts[id] ?? null : null;
  }
  async getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null> {
    const sourceHash = hash(sourceId); const entry = await this.storage.get(draftPrefix + sourceHash);
    if (!entry) return null;
    const state = this.decode(entry.value, sourceHash);
    return state.activeId ? state.drafts[state.activeId]! : null;
  }
  private async update(id: string, mutate: (draft: CommunityIssueDraft) => CommunityIssueDraft, allowed: readonly string[] = ['draft']): Promise<CommunityIssueDraft> {
    const sourceHash = this.sourceHash(id); const key = draftPrefix + sourceHash;
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(key); if (!entry) throw new Error(`Draft ${id} not found`);
      const state = this.decode(entry.value, sourceHash); const previous = state.drafts[id];
      if (!previous) throw new Error(`Draft ${id} not found`);
      if (!allowed.includes(previous.status)) throw new Error(`Draft ${id} is ${previous.status} (not draft)`);
      const draft = draftSchema.parse(mutate(previous));
      const next = { ...state, activeId: draft.status === 'cancelled' ? null : id, drafts: { ...state.drafts, [id]: draft } };
      if ((await this.storage.compareAndSet(key, entry.revision, next)).applied) return draft;
    }
    throw new Error('Draft changed concurrently');
  }
  beginPublish(id: string, title: string, bodyMarkdown: string) {
    return this.update(id, draft => {
      if (draft.status !== 'draft' && (draft.title !== title || draft.bodyMarkdown !== bodyMarkdown)) throw new Error('Publication content is immutable');
      return { ...draft, title, bodyMarkdown, status: draft.status === 'draft' ? 'publishing' : draft.status };
    }, ['draft', 'publishing', 'published']);
  }
  publish(input: PublishDraftInput) {
    return this.update(input.draftId, draft => {
      if (draft.status === 'published') {
        if (draft.githubIssueNumber !== input.githubIssueNumber || draft.githubIssueUrl !== input.githubIssueUrl) throw new Error('Publication identity changed');
        return draft;
      }
      return { ...draft, status: 'published', githubIssueNumber: input.githubIssueNumber, githubIssueUrl: input.githubIssueUrl, publishedAt: Date.now() };
    }, ['publishing', 'published']);
  }
  cancel(id: string) { return this.update(id, draft => ({ ...draft, status: 'cancelled', cancelledAt: Date.now() })); }
  updateContent(id: string, title: string, bodyMarkdown: string) { return this.update(id, draft => ({ ...draft, title, bodyMarkdown })); }
}
