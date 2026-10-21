import { createHash, randomUUID } from 'node:crypto';
import type { FeatureContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { previewPublicIssue } from './community-read-model.js';

export interface PublishedIssue { number: number; url: string }
export interface NativeIssueDraft {
  id: string; repo: string; title: string; bodyMarkdown: string; marker: string;
  createdAt: number; status: 'draft' | 'publishing' | 'published' | 'cancelled';
  issue?: PublishedIssue;
  labels?: readonly string[];
  creationDigest?: string;
}
export interface NativeIssuePublisher {
  create(draft: NativeIssueDraft, signal: AbortSignal): Promise<PublishedIssue>;
  find(draft: NativeIssueDraft, signal: AbortSignal): Promise<PublishedIssue | null>;
}
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const publicationBody = (draft: NativeIssueDraft) => `${draft.bodyMarkdown}\n\n<!-- clowder-draft:${draft.marker} -->`;
const contentDigest = (draft: Pick<NativeIssueDraft, 'repo' | 'title' | 'bodyMarkdown' | 'labels'>) =>
  createHash('sha256').update(JSON.stringify([draft.repo, draft.title, draft.bodyMarkdown, draft.labels ?? []])).digest('hex');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('draft input required');
  return value as Record<string, unknown>;
}
function draftId(value: unknown): string {
  // Generic owner operation merges stored configuration into input. Consume only
  // the row's draftId, never token, userId or a claimed confirmation/principal.
  const input = object(object(value).input);
  if (typeof input.draftId !== 'string' || !/^[a-f0-9]{64}$/.test(input.draftId)) throw new TypeError('invalid native draft ID');
  return input.draftId;
}
function validateIssue(repo: string, issue: PublishedIssue): PublishedIssue {
  if (!Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.url !== 'string' || issue.url.toLowerCase() !== `https://github.com/${repo}/issues/${issue.number}`) {
    throw new Error('invalid GitHub publication identity');
  }
  return { number: issue.number, url: issue.url };
}
function readDraft(value: unknown, id: string): NativeIssueDraft {
  const draft = object(value);
  if (draft.id !== id || typeof draft.repo !== 'string' || !repoPattern.test(draft.repo) || draft.repo !== draft.repo.toLowerCase() ||
    typeof draft.title !== 'string' || !draft.title.trim() || typeof draft.bodyMarkdown !== 'string' ||
    typeof draft.marker !== 'string' || !/^[a-f0-9-]{36}$/.test(draft.marker) ||
    typeof draft.createdAt !== 'number' || !Number.isSafeInteger(draft.createdAt) ||
    !['draft', 'publishing', 'published', 'cancelled'].includes(draft.status as string)) throw new Error('invalid native draft record');
  if (draft.labels !== undefined && (!Array.isArray(draft.labels) || draft.labels.length > 10 || draft.labels.some(value => typeof value !== 'string' || !value.trim() || value.length > 50))) throw new Error('invalid draft labels');
  if (draft.creationDigest !== undefined && (typeof draft.creationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(draft.creationDigest))) throw new Error('invalid draft creation digest');
  if (draft.status === 'published') validateIssue(draft.repo, object(draft.issue) as unknown as PublishedIssue);
  return draft as unknown as NativeIssueDraft;
}

/** Installation-private drafts are deliberately separate from legacy Host
 * drafts: no userId, source confirmation or guardian authority is imported. */
export class NativeIssueDraftRuntime {
  private readonly abort = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly context: Pick<FeatureContext, 'storage' | 'config'>, private readonly publisher: NativeIssuePublisher,
    private readonly prefix: 'community.native-draft.' | 'community.workflow.publication.' = 'community.native-draft.') {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.catch(() => {}).then(() => { this.abort.signal.throwIfAborted(); return action(); });
    this.tail = pending;
    return pending;
  }
  async stop(): Promise<void> { this.abort.abort(); await this.tail.catch(() => {}); }
  private async allowed(repo: string): Promise<void> {
    const config = await this.context.config.get('publishRepositories');
    if (typeof config !== 'string' || !config.split(/[\s,]+/).some(value => value.toLowerCase() === repo)) throw new Error('repository is not in publish allowlist');
  }
  create(value: unknown) {
    return this.run(async () => {
      const input = object(value);
      if (Object.keys(input).some(key => !['requestId', 'repo', 'title', 'bodyMarkdown', 'labels'].includes(key))) throw new TypeError('unsupported native draft field');
      if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId) ||
        typeof input.repo !== 'string' || input.repo.length > 200 || !repoPattern.test(input.repo) ||
        typeof input.bodyMarkdown !== 'string' || input.bodyMarkdown.length > 65000) throw new TypeError('invalid native draft source, repository or body');
      const labels = input.labels ?? [];
      if (!Array.isArray(labels) || labels.length > 10 || labels.some(value => typeof value !== 'string' || !value.trim() || value.length > 50)) throw new TypeError('invalid draft labels');
      const repo = input.repo.toLowerCase();
      await this.allowed(repo);
      const { data: clean } = await previewPublicIssue({ title: input.title, bodyMarkdown: input.bodyMarkdown });
      const id = createHash('sha256').update(input.requestId).digest('hex');
      const draft: NativeIssueDraft = { id, repo, title: clean.title, bodyMarkdown: clean.bodyMarkdown,
        labels, marker: randomUUID(), createdAt: Date.now(), status: 'draft' };
      draft.creationDigest = contentDigest(draft);
      const key = this.prefix + id;
      const result = await this.context.storage.compareAndSet(key, null, draft);
      const existing = result.applied ? draft : readDraft((await this.context.storage.get(key))?.value, id);
      if ((existing.creationDigest ?? contentDigest(existing)) !== draft.creationDigest) throw new Error('draft requestId already has different content');
      return { data: existing };
    });
  }
  list() {
    return this.run(async () => {
      const records = Object.entries(await this.context.storage.list()).filter(([key]) => key.startsWith(this.prefix))
        .map(([key, entry]) => readDraft(entry.value, key.slice(this.prefix.length))).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return { render: 'rows' as const, label: `Latest ${Math.min(records.length, 200)} of ${records.length} drafts. Full records remain available by draft ID.`, data: { rows: records.slice(0, 200).map(draft => {
        return { key: draft.id, label: draft.title.slice(0, 200),
          detail: `${draft.repo} · ${draft.status}${draft.issue ? ` · ${draft.issue.url}` : ''}`,
          actions: draft.status === 'cancelled' || draft.status === 'published' ? [] : [
            { action: 'publish', input: { draftId: draft.id } },
            ...(draft.status === 'draft' ? [{ action: 'cancel', input: { draftId: draft.id } }] : []),
          ] };
      }), empty: 'No plugin-native drafts. Legacy Host drafts remain in their existing entry point.' } };
    });
  }
  get(value: unknown) {
    return this.run(async () => {
      const input = object(value);
      if (Object.keys(input).some(key => key !== 'draftId') || typeof input.draftId !== 'string' || !/^[a-f0-9]{64}$/.test(input.draftId)) throw new TypeError('invalid draft lookup');
      const entry = await this.context.storage.get(this.prefix + input.draftId);
      if (!entry) throw new Error('native draft not found');
      return { data: readDraft(entry.value, input.draftId) };
    });
  }
  cancel(value: unknown) {
    return this.run(async () => {
      const id = draftId(value), entry = await this.context.storage.get(this.prefix + id);
      if (!entry) throw new Error('native draft not found');
      const draft = readDraft(entry.value, id);
      if (draft.status !== 'draft' && draft.status !== 'cancelled') throw new Error('publication has started; reconcile before any further action');
      await this.save(id, entry.revision, { ...draft, status: 'cancelled' });
      return { render: 'status' as const, data: { id, status: 'cancelled' } };
    });
  }
  publish(value: unknown, edits?: { title?: string; bodyMarkdown?: string }) {
    return this.run(async () => {
      const id = draftId(value), key = this.prefix + id;
      let entry = await this.context.storage.get(key);
      if (!entry) throw new Error('native draft not found; legacy drafts cannot be adopted');
      let draft = readDraft(entry.value, id);
      if (draft.status === 'cancelled') throw new Error('draft cancelled');
      if (draft.status === 'published') return { render: 'status' as const, data: { id, status: 'published', issue: draft.issue } };
      await this.allowed(draft.repo);
      if (edits) {
        const { data: clean } = await previewPublicIssue({ title: edits.title ?? draft.title, bodyMarkdown: edits.bodyMarkdown ?? draft.bodyMarkdown });
        if (draft.status !== 'draft' && (clean.title !== draft.title || clean.bodyMarkdown !== draft.bodyMarkdown)) throw new Error('Publication content is immutable');
        draft = { ...draft, creationDigest: draft.creationDigest ?? contentDigest(draft), title: clean.title, bodyMarkdown: clean.bodyMarkdown };
      }
      const clean = await previewPublicIssue({ title: draft.title, bodyMarkdown: draft.bodyMarkdown });
      if (clean.data.title !== draft.title || clean.data.bodyMarkdown !== draft.bodyMarkdown) throw new Error('draft no longer passes sanitization');
      const recovering = draft.status === 'publishing';
      if (!recovering) {
        draft = { ...draft, status: 'publishing' };
        await this.save(id, entry.revision, draft);
        entry = await this.context.storage.get(key);
        if (!entry) throw new Error('publication journal missing');
      }
      let issue: PublishedIssue | null;
      try {
        this.abort.signal.throwIfAborted();
        issue = recovering ? await this.publisher.find(draft, this.abort.signal) : await this.publisher.create(draft, this.abort.signal);
        if (issue) issue = validateIssue(draft.repo, issue);
      } catch {
        // POST may have succeeded. Never roll back to draft or issue a second
        // POST after timeout, shutdown, process death or ambiguous response.
        issue = null;
      }
      if (!issue) return { render: 'status' as const, label: 'Publication outcome uncertain. Retry to look for the original issue; this will not create another issue.', data: { id, status: 'uncertain' } };
      await this.save(id, entry.revision, { ...draft, status: 'published', issue });
      return { render: 'status' as const, data: { id, status: 'published', issue } };
    });
  }
  private async save(id: string, revision: Awaited<ReturnType<PluginStorageHost['set']>>['revision'], draft: NativeIssueDraft) {
    if (!(await this.context.storage.compareAndSet(this.prefix + id, revision, draft)).applied) throw new Error('native draft changed concurrently');
  }
}
