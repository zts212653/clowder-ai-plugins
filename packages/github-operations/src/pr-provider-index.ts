import { createHash, randomUUID } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { mapGitHubPr, type GhPrFull, type GhPrReview } from './business/domains/community/github/GitHubPrFetcher.js';

export interface PrIndexProvider {
  /** One complete page, in stable provider number order, at most 25 rows. */
  page(repo: string, page: number, signal: AbortSignal): Promise<unknown[]>;
  /** One complete review page; durable continuation belongs to the index. */
  reviewPage(repo: string, number: number, page: number, signal: AbortSignal): Promise<unknown[]>;
}
interface PrRow {
  repo: string; number: number; subjectKey: string; updatedAt: number; title: string; author: string; draft: boolean;
  state: 'open' | 'closed' | 'merged'; replyState: 'unreplied' | 'replied' | 'has-new-activity';
  headSha: string; lastReviewedSha: string | null;
}
interface PendingPage { key: string; count: number; offset: number; reviewPage: number; lastReview: GhPrReview | null; rows: PrRow[] }
interface Draft { rowSchema?: 2; generation: string; page: number; parts: string[]; numbers: number[]; pending: PendingPage | null }
class IndexLimitError extends Error {}
interface Published { generation: string; count: number; observedAt: number; parts: string[] }
interface Root { schema: 1; repo: string; published: Published | null; draft: Draft | null }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const prefix = (repo: string) => `github.pr-index.v1.${hash(repo)}.`;
const rootKey = (repo: string) => `${prefix(repo)}root`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('PR index object required');
  return value as Record<string, unknown>;
}
function repoOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new TypeError('invalid repository');
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new TypeError('invalid PR metadata string');
  return value;
}
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(result)) throw new TypeError('invalid PR commit');
  return result;
}
function activityTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new TypeError('invalid provider updated_at');
  const millis = Date.parse(value), normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) throw new TypeError('invalid provider updated_at');
  return millis;
}
function metadata(value: unknown): GhPrFull {
  const p = object(value);
  if (!Number.isSafeInteger(p.number) || (p.number as number) < 1 || !['open', 'closed'].includes(p.state as string) ||
      typeof p.draft !== 'boolean' || (p.merged_at !== null && (typeof p.merged_at !== 'string' || !Number.isFinite(Date.parse(p.merged_at))))) {
    throw new TypeError('invalid PR metadata');
  }
  return { number: p.number as number, title: text(p.title, 1024), user: text(p.user, 100),
    state: p.state as string, merged_at: p.merged_at as string | null, head_sha: sha(p.head_sha), draft: p.draft,
    labels: [], updated_at: new Date(activityTime(p.updated_at)).toISOString() };
}
function review(value: unknown): GhPrReview {
  const r = object(value);
  return { user: text(r.user, 100), state: text(r.state, 40), commit_id: sha(r.commit_id) };
}
function storedRow(value: unknown, repo: string): PrRow {
  const row = object(value);
  if (row.repo !== repo || !Number.isSafeInteger(row.number) || (row.number as number) < 1 || typeof row.draft !== 'boolean' ||
      !['open', 'closed', 'merged'].includes(row.state as string) || !['unreplied', 'replied', 'has-new-activity'].includes(row.replyState as string)) throw new TypeError('invalid stored PR row');
  if (row.subjectKey !== `pr:${repo}#${row.number}` || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) throw new TypeError('PR observation refresh required: missing identity or provider activity time');
  return { repo, number: row.number as number, subjectKey: row.subjectKey as string, updatedAt: row.updatedAt,
    title: text(row.title, 1024), author: text(row.author, 100), state: row.state as PrRow['state'],
    replyState: row.replyState as PrRow['replyState'], headSha: sha(row.headSha),
    lastReviewedSha: row.lastReviewedSha === null ? null : sha(row.lastReviewedSha), draft: row.draft };
}
function rootOf(value: unknown, repo: string): Root {
  const r = object(value);
  if (r.schema !== 1 || r.repo !== repo) throw new TypeError('invalid PR index root');
  for (const kind of ['published', 'draft'] as const) {
    if (r[kind] === null) continue;
    const p = object(r[kind]);
    if (typeof p.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(p.generation) || !Array.isArray(p.parts) || p.parts.length > 201 ||
        p.parts.some(key => typeof key !== 'string' || !key.startsWith(`${prefix(repo)}${p.generation}.`) || key.length > 200)) throw new TypeError('invalid PR index generation');
    if (kind === 'published' && (!Number.isSafeInteger(p.count) || (p.count as number) < 0 || (p.count as number) > 5000 ||
        !Number.isFinite(p.observedAt) || p.parts.length !== Math.floor((p.count as number) / 25) + 1)) throw new TypeError('invalid published PR index');
    if (kind === 'draft' && (!Number.isSafeInteger(p.page) || (p.page as number) < 1 || (p.page as number) > 201 ||
        !Array.isArray(p.numbers) || p.numbers.length > 5000 || p.numbers.some(n => !Number.isSafeInteger(n) || n < 1) ||
        new Set(p.numbers).size !== p.numbers.length || p.parts.length !== (p.page as number) - 1 || p.numbers.length !== p.parts.length * 25)) throw new TypeError('invalid staged PR index');
    if (kind === 'draft') {
      // Unversioned drafts can contain alpha.12 chunks even after alpha.13 touched
      // their continuation. Validate their envelope, but never reuse their parts.
      if (p.rowSchema !== undefined && p.rowSchema !== 2) throw new TypeError('unsupported PR draft row schema');
      if (p.rowSchema === 2 && p.pending === undefined) throw new TypeError('missing PR continuation');
      if (p.pending !== null && p.pending !== undefined) {
        const n = object(p.pending);
        if (typeof n.key !== 'string' || !n.key.startsWith(`${prefix(repo)}${p.generation}.`) || n.key.length > 200 ||
          !Number.isInteger(n.count) || (n.count as number) < 1 || (n.count as number) > 25 ||
          !Number.isInteger(n.offset) || (n.offset as number) < 0 || (n.offset as number) >= (n.count as number) ||
          !Number.isInteger(n.reviewPage) || (n.reviewPage as number) < 1 || (n.reviewPage as number) > 100 ||
          !Array.isArray(n.rows) || n.rows.length !== n.offset) throw new TypeError('invalid PR review continuation');
        n.rows.forEach(row => storedRow(row, repo));
        if (n.lastReview !== null) review(n.lastReview);
      }
    }
  }
  return r as unknown as Root;
}

/** Repository observations publish at one root CAS. Staging never replaces a
 * visible row, invokes Host governance, sends a notification or starts polling. */
export class PrProviderIndex {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: PluginStorageHost, private readonly provider: PrIndexProvider,
    private readonly timeoutMs = 30_000) {}

  async refresh(value: unknown) {
    const input = object(value), repo = repoOf(input.repo);
    if (Object.keys(input).some(k => !['repo', 'restart'].includes(k)) || (input.restart !== undefined && typeof input.restart !== 'boolean')) throw new TypeError('unsupported PR refresh field');
    this.lifetime.signal.throwIfAborted();
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.step(repo, input.restart === true));
    this.queues.set(repo, work); this.pending.add(work);
    try { return await work; } finally {
      this.pending.delete(work); if (this.queues.get(repo) === work) this.queues.delete(repo);
    }
  }

  private async step(repo: string, restart: boolean) {
    this.lifetime.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('PR refresh timed out')), this.timeoutMs);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal]);
    try {
      const entry = await this.storage.get(rootKey(repo));
      let revision = entry?.revision ?? null;
      let root: Root = entry ? rootOf(entry.value, repo) : { schema: 1, repo, published: null, draft: null };
      let draft: Draft = !restart && root.draft?.rowSchema === 2 ? root.draft :
        { rowSchema: 2, generation: randomUUID(), page: 1, parts: [], numbers: [], pending: null };
      let failedSubject: number | null = null;
      const save = async (next: Root) => {
        signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(next)) > 128 * 1024) throw new IndexLimitError('PR continuation exceeds storage bound');
        const result = await this.storage.compareAndSet(rootKey(repo), revision, next);
        if (!result.applied) throw new Error('PR refresh changed concurrently');
        if (typeof result.revision !== 'number') throw new Error('PR storage omitted applied revision');
        revision = result.revision; root = next;
      };
      const chunk = async (value: unknown) => {
        signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new IndexLimitError('PR page exceeds storage bound');
        const key = `${prefix(repo)}${draft.generation}.${randomUUID()}`;
        if (!(await this.storage.compareAndSet(key, null, value)).applied) throw new Error('PR generation key collision');
        return key;
      };
      try {
        let prs: GhPrFull[];
        if (draft.pending) {
          const staged = await this.storage.get(draft.pending.key);
          if (!staged || !Array.isArray(staged.value) || staged.value.length !== draft.pending.count) throw new TypeError('missing staged PR metadata');
          prs = staged.value.map(metadata);
        } else {
          const values = await this.provider.page(repo, draft.page, signal); signal.throwIfAborted();
          if (!Array.isArray(values) || values.length > 25) throw new TypeError('oversized PR page');
          prs = values.map(metadata);
          const numbers = new Set(draft.numbers);
          for (const pr of prs) {
            if (numbers.has(pr.number)) throw new TypeError('duplicate PR in refresh');
            numbers.add(pr.number);
          }
          if (numbers.size > 5000) throw new IndexLimitError('PR subject limit exceeded');
          if (prs.length) {
            draft = { ...draft, pending: { key: await chunk(prs), count: prs.length, offset: 0, reviewPage: 1, lastReview: null, rows: [] } };
            await save({ ...root, draft });
          }
        }
        let rows = draft.pending?.rows ?? [];
        while (draft.pending) {
          signal.throwIfAborted();
          const pending = draft.pending, pr = prs[pending.offset]!;
          failedSubject = pr.number;
          const raw = pr.state === 'open' ? await this.provider.reviewPage(repo, pr.number, pending.reviewPage, signal) : [];
          signal.throwIfAborted();
          if (!Array.isArray(raw) || raw.length > 100) throw new TypeError('oversized PR review page');
          let lastReview = pending.lastReview;
          for (const value of raw) { const r = review(value); if (r.user !== pr.user) lastReview = r; }
          if (raw.length === 100) {
            if (pending.reviewPage === 100) throw new IndexLimitError('PR review page limit exceeded');
            draft = { ...draft, pending: { ...pending, reviewPage: pending.reviewPage + 1, lastReview } };
            await save({ ...root, draft });
            continue;
          }
          rows = [...pending.rows, { repo, number: pr.number, subjectKey: `pr:${repo}#${pr.number}`, updatedAt: activityTime(pr.updated_at),
            title: pr.title, author: pr.user, draft: pr.draft, headSha: pr.head_sha, ...mapGitHubPr(pr, lastReview ? [lastReview] : []) }];
          if (rows.length === prs.length) break;
          draft = { ...draft, pending: { ...pending, offset: pending.offset + 1, reviewPage: 1, lastReview: null, rows } };
          await save({ ...root, draft });
        }
        signal.throwIfAborted(); failedSubject = null;
        const parts = [...draft.parts, await chunk(rows)], complete = prs.length < 25;
        const numbers = [...draft.numbers, ...prs.map(pr => pr.number)];
        await save({ schema: 1, repo,
          published: complete ? { generation: draft.generation, count: numbers.length, observedAt: Date.now(), parts } : root.published,
          draft: complete ? null : { rowSchema: 2, generation: draft.generation, page: draft.page + 1, parts, numbers, pending: null } });
        return { status: complete ? 'complete' : 'incomplete', complete, hasMore: !complete,
          stagedCount: numbers.length, publishedGeneration: root.published?.generation ?? null,
          observedAt: root.published?.observedAt ?? null, failedSubjects: [] };
      } catch (error) {
        // The attempt is separate from the immutable published rows/root. A later
        // successful root revision makes this failure metadata inapplicable.
        const limited = error instanceof IndexLimitError;
        if (!this.lifetime.signal.aborted) await this.storage.set(`${prefix(repo)}attempt`, {
          rootRevision: revision, status: limited ? 'limit_exceeded' : 'failed', attemptedAt: Date.now(),
          failedSubjects: failedSubject === null ? [] : [failedSubject],
        });
        if (this.lifetime.signal.aborted) throw error;
        return { status: limited ? 'limit_exceeded' : 'failed', complete: false, hasMore: !limited, restartRequired: limited,
          publishedGeneration: root.published?.generation ?? null,
          failedSubjects: failedSubject === null ? [] : [failedSubject] };
      }
    } finally { clearTimeout(timer); }
  }

  async read(repoValue: unknown, after?: unknown, limitValue: unknown = 50) {
    this.lifetime.signal.throwIfAborted();
    const repo = repoOf(repoValue), limit = limitValue;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError('invalid PR page limit');
    const entry = await this.storage.get(rootKey(repo));
    const root = entry ? rootOf(entry.value, repo) : null, published = root?.published;
    let offset = 0;
    if (after !== undefined) {
      if (typeof after !== 'string' || after.length > 160) throw new TypeError('invalid PR cursor');
      const match = /^([a-f0-9-]{36}):([0-9]+)$/.exec(after);
      if (!match || match[1] !== published?.generation || !Number.isSafeInteger(Number(match[2]))) throw new TypeError('stale or invalid PR cursor');
      offset = Number(match[2]); if (offset > published.count) throw new TypeError('invalid PR cursor offset');
    }
    const attempt = await this.storage.get(`${prefix(repo)}attempt`);
    const failure = attempt && object(attempt.value).rootRevision === (entry?.revision ?? null) ? object(attempt.value) : null;
    const items: PrRow[] = [];
    const end = Math.min(published?.count ?? 0, offset + (limit as number));
    if (published) for (let index = Math.floor(offset / 25); index < Math.ceil(end / 25); index++) {
      const part = await this.storage.get(published.parts[index]!);
      if (!part || !Array.isArray(part.value) || part.value.length > 25) throw new TypeError('missing or malformed PR generation page');
      for (const value of part.value.slice(Math.max(0, offset - index * 25), Math.min(25, end - index * 25))) {
        items.push(storedRow(value, repo));
      }
    }
    if (items.length !== end - offset) throw new TypeError('incomplete published PR generation');
    return { items, publishedGeneration: published?.generation ?? null, observedAt: published?.observedAt ?? null,
      refreshStatus: failure ? failure.status : root?.draft ? 'incomplete' : published ? 'complete' : 'never',
      failedSubjects: failure?.failedSubjects ?? [],
      nextAfter: published && end < published.count ? `${published.generation}:${end}` : null };
  }

  async repositories() {
    this.lifetime.signal.throwIfAborted();
    const entries = await this.storage.list();
    const result: { repo: string; publishedGeneration: string; observedAt: number; count: number }[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^github\.pr-index\.v1\.[a-f0-9]{64}\.root$/.test(key)) continue;
      const repo = repoOf(object(entry.value).repo);
      if (key !== rootKey(repo)) throw new TypeError('invalid PR repository key');
      const root = rootOf(entry.value, repo);
      if (root.published) result.push({ repo, publishedGeneration: root.published.generation, observedAt: root.published.observedAt, count: root.published.count });
    }
    return result.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async stop() { this.lifetime.abort(new Error('PR index stopped')); await Promise.allSettled([...this.pending]); }
}
