import { z } from 'zod';
import type { PluginActionContext, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { awaitGitHubCaller } from './business/infrastructure/github/abortable-wait.js';
import { executeGitHubRequest, gitHubCredentialKey, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

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
}

/** Presentation-only provider read, moved from main's pr-title-reader. It never
 * starts tracking, refreshes an index, writes storage or admits a Task. */
export class GitHubPrTitleReader {
  private readonly lifecycle = new AbortController();
  private readonly pending = new Set<Promise<string | null>>();
  private readonly cache = new Map<string, { title: string; expiresAt: number }>();
  constructor(private readonly options: Options) {}

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
    const token = await awaitGitHubCaller(this.options.token(), signal);
    const key = `${await awaitGitHubCaller(gitHubCredentialKey(token), signal)}:${ref}`;
    signal.throwIfAborted();
    const now = this.options.now ?? Date.now;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.title;
    const { stdout } = await executeGitHubRequest(['api', `repos/${target.repoFullName}/pulls/${target.prNumber}`,
      '--jq', '{number,title,repository:.base.repo.full_name}'],
    { ghToken: token, signal, timeoutMs: 2_000, execFileAsync: this.options.execFileAsync });
    signal.throwIfAborted();
    const data: unknown = JSON.parse(stdout);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const { number, title, repository } = data as Record<string, unknown>;
    if (number !== target.prNumber || typeof repository !== 'string' || repository.toLowerCase() !== target.repoFullName ||
      typeof title !== 'string' || !title.trim()) return null;
    const value = title.trim();
    this.cache.delete(key);
    this.cache.set(key, { title: value, expiresAt: now() + 60_000 });
    const oldest = this.cache.keys().next().value;
    if (this.cache.size > 256 && oldest !== undefined) this.cache.delete(oldest);
    return value;
  }
}

const request = z.object({ request: z.object({
  method: z.literal('GET'), path: z.literal('github/pr-title'),
  query: z.object({ ref: z.string() }).strict(),
  principal: z.object({ kind: z.literal('owner'), id: z.string().min(1) }).strict(),
}) }).strict();

export function prTitleHttp(reader: GitHubPrTitleReader) {
  return async (input: unknown, native?: PluginActionContext, owner?: PluginHostActionContext) => {
    if (native || owner?.kind !== 'owner-http-request' || owner.operation !== 'read' || !owner.userId || !owner.pluginInstanceId)
      throw new Error('Host-authenticated owner HTTP required');
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    const { request: value } = request.parse(input);
    if (value.principal.id !== owner.userId) throw new Error('Host-authenticated owner HTTP principal mismatch');
    const title = await reader.read(value.query.ref, owner.signal);
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    return { status: 200, headers: { 'content-type': 'application/json' }, body: { title } };
  };
}
