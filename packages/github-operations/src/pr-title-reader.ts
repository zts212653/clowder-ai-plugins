import { z } from 'zod';
import type { PluginActionContext, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { awaitGitHubCaller } from './business/infrastructure/github/abortable-wait.js';
import { executeGitHubRequest, gitHubCredentialKey, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import type { ICommunityPrStore } from './business/domains/community/ports/CommunityPrStore.js';
import type { GitHubSnapshot, GitHubTarget } from './tracking-runtime.js';

// Moved from main's parsePullRequestFullRef; preserve its exact coordinate rules.
function parseRef(ref: unknown): { repoFullName: string; prNumber: number } | null {
  if (typeof ref !== 'string') return null;
  const match = /^([^#]+)#([1-9]\d*)$/.exec(ref);
  if (!match || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(match[1] ?? '')) return null;
  const name = match[1]!.split('/')[1];
  if (name === '.' || name === '..') return null;
  const prNumber = Number(match[2]);
  return Number.isSafeInteger(prNumber) ? { repoFullName: match[1]!.toLowerCase(), prNumber } : null;
}

interface Options {
  token(): Promise<string | undefined>;
  execFileAsync?: GitHubRequestOptions['execFileAsync'];
  now?: () => number;
  records?: Pick<ICommunityPrStore, 'getByRepoAndNumber' | 'observeTitle'>;
}

const metadata = z.object({ number: z.number().int().positive().safe(), title: z.string(), repository: z.string(),
  author: z.string().min(1).optional(), state: z.enum(['open', 'closed']).optional(),
  mergedAt: z.string().nullable().optional(), headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).optional(), draft: z.boolean().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional() });

/** Titles use the original plugin-private PR record; local reads never consult the provider. */
export class GitHubPrTitleReader {
  private readonly lifecycle = new AbortController();
  private readonly pending = new Set<Promise<string | null>>();
  private readonly cache = new Map<string, { title: string; expiresAt: number }>();
  constructor(private readonly options: Options) {}

  async readLocal(ref: unknown, callerSignal?: AbortSignal): Promise<string | null> {
    this.lifecycle.signal.throwIfAborted(); callerSignal?.throwIfAborted();
    const target = parseRef(ref);
    if (!target || !this.options.records) return null;
    const record = await this.options.records.getByRepoAndNumber(target.repoFullName, target.prNumber);
    this.lifecycle.signal.throwIfAborted(); callerSignal?.throwIfAborted();
    return record?.title.trim() || null;
  }

  async observe(target: GitHubTarget, snapshot: GitHubSnapshot) {
    const records = this.options.records;
    if (!records || target.kind !== 'pr' || !snapshot.title?.trim() || !snapshot.authorLogin || !snapshot.headSha || snapshot.draft === undefined) return;
    this.lifecycle.signal.throwIfAborted();
    await records.observeTitle({ repo: target.repoFullName, prNumber: target.number, title: snapshot.title.trim(),
      author: snapshot.authorLogin, state: snapshot.state, headSha: snapshot.headSha, draft: snapshot.draft, replyState: 'unreplied' },
      { observedAt: snapshot.observedAt ?? (this.options.now ?? Date.now)(),
        ...(snapshot.providerUpdatedAt !== undefined ? { providerUpdatedAt: Date.parse(snapshot.providerUpdatedAt) } : {}) });
  }

  async read(ref: unknown, callerSignal?: AbortSignal): Promise<string | null> {
    this.lifecycle.signal.throwIfAborted();
    callerSignal?.throwIfAborted();
    const target = parseRef(ref);
    if (!target) return null;
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(2_000), ...(callerSignal ? [callerSignal] : [])]);
    const pending = this.query(ref as string, target, signal);
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  async stop(): Promise<void> {
    this.lifecycle.abort(new Error('PR title reader stopped'));
    this.cache.clear();
    await Promise.allSettled([...this.pending]);
  }

  private async query(ref: string, target: { repoFullName: string; prNumber: number }, signal: AbortSignal): Promise<string | null> {
    const now = this.options.now ?? Date.now;
    const observedAt = now();
    const token = await awaitGitHubCaller(this.options.token(), signal);
    const key = `${await awaitGitHubCaller(gitHubCredentialKey(token), signal)}:${ref}`;
    signal.throwIfAborted();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now()) {
      if (!this.options.records) return cached.title;
      const record = await this.options.records.getByRepoAndNumber(target.repoFullName, target.prNumber);
      signal.throwIfAborted();
      return record?.title.trim() || null;
    }
    const { stdout } = await executeGitHubRequest(['api', `repos/${target.repoFullName}/pulls/${target.prNumber}`,
      '--jq', '{number,title,repository:.base.repo.full_name,author:.user.login,state,mergedAt:.merged_at,headSha:.head.sha,draft,updatedAt:.updated_at}'],
    { ghToken: token, signal, timeoutMs: 2_000, execFileAsync: this.options.execFileAsync });
    signal.throwIfAborted();
    const parsed = metadata.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const { number, title, repository, author, state, mergedAt, headSha, draft, updatedAt } = parsed.data;
    if (number !== target.prNumber || repository.toLowerCase() !== target.repoFullName || !title.trim()) return null;
    let value = title.trim();
    const records = this.options.records;
    if (records) {
      if (!author || !state || mergedAt === undefined || !headSha || draft === undefined)
        throw new Error('Incomplete PR title observation');
      signal.throwIfAborted();
      const saved = await records.observeTitle({ repo: target.repoFullName, prNumber: target.prNumber, title: value, author,
        state: mergedAt !== null ? 'merged' : state, headSha, draft, replyState: 'unreplied' },
        { observedAt, ...(updatedAt !== undefined ? { providerUpdatedAt: Date.parse(updatedAt) } : {}) });
      value = saved.title;
      signal.throwIfAborted();
    }
    this.cache.delete(key);
    this.cache.set(key, { title: value, expiresAt: now() + 60_000 });
    const oldest = this.cache.keys().next().value;
    if (this.cache.size > 256 && oldest !== undefined) this.cache.delete(oldest);
    return value;
  }
}

const request = z.object({ request: z.object({
  method: z.literal('GET'), path: z.literal('github/pr-title'),
  query: z.object({ ref: z.string(), mode: z.literal('local').optional() }).strict(),
  principal: z.object({ kind: z.literal('owner'), id: z.string().min(1) }).strict(),
}) }).strict();

export function prTitleHttp(reader: GitHubPrTitleReader) {
  return async (input: unknown, native?: PluginActionContext, owner?: PluginHostActionContext) => {
    if (native || owner?.kind !== 'owner-http-request' || owner.operation !== 'read' || !owner.userId || !owner.pluginInstanceId)
      throw new Error('Host-authenticated owner HTTP required');
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    const { request: value } = request.parse(input);
    if (value.principal.id !== owner.userId) throw new Error('Host-authenticated owner HTTP principal mismatch');
    const title = await (value.query.mode === 'local' ? reader.readLocal(value.query.ref, owner.signal) : reader.read(value.query.ref, owner.signal));
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    return { status: 200, headers: { 'content-type': 'application/json' }, body: { title } };
  };
}
