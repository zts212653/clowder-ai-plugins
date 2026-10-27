import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginActionHandler, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

const publicationSchema = z.object({
  publicationId: z.string().min(1).max(200),
  serviceInstanceId: z.string().min(1),
  collectiveId: z.string().min(1),
  connectionId: z.string().min(1),
  humanId: z.string().min(1),
  roadmapId: z.string().min(1),
  channelId: z.string().min(1),
  sourceEventId: z.string().startsWith('evt_'),
  provider: z.literal('github'),
  sourceId: z.string().min(1).max(2048),
});
const inputSchema = z
  .object({
    input: z
      .object({
        operation: z
          .object({ action: z.enum(['publish', 'read']), publication: publicationSchema })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    operationState: z.unknown().optional(),
  })
  .strict();
const receiptSchema = z
  .object({
    v: z.literal(1),
    ownerUserId: z.string(),
    pluginInstanceId: z.string(),
    publication: publicationSchema,
    principal: z.string().min(1),
    publishedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: z.string().datetime(),
  })
  .strict();
const subjectSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(4096),
    body: z.string().max(1_000_000).nullable(),
    user: z.object({ login: z.string().min(1).max(200) }),
    updated_at: z.string().datetime(),
    html_url: z.string().url(),
    repository_url: z.string().url().optional(),
    base: z.object({ repo: z.object({ full_name: z.string() }) }).optional(),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }).optional(),
  })
  .passthrough();
const absent = (reason: 'not_published' | 'access_revoked' | 'owner_unavailable') => ({
  render: 'status',
  data: { status: 'unavailable', reason },
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function parseGitHubMaterialSource(ref: string) {
  const full = /^(pr|issue):([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9]\d*)$/.exec(ref);
  const url =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(
      ref,
    );
  if (!full && !url) throw new Error('Choose an exact GitHub PR or Issue in a registered repository');
  const kind = full ? (full[1] as 'pr' | 'issue') : url![2] === 'pull' ? 'pr' : 'issue';
  const repo = (full?.[2] ?? url![1]!).toLowerCase(),
    number = Number(full?.[3] ?? url![3]);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid GitHub subject number');
  return { kind, repo, number, key: `${kind}:${repo}#${number}` };
}

/** Current provider reads only: neither repository caches nor registration imply public sharing consent. */
export function createGitHubSourcePublication(deps: {
  storage: PluginStorageHost;
  token(): Promise<string | undefined>;
  allowed(repo: string): Promise<boolean>;
  execFileAsync?: GitHubRequestOptions['execFileAsync'];
}): PluginActionHandler {
  return async (unsafe, native, owner) => {
    if (
      native ||
      owner?.kind !== 'owner-operation' ||
      owner.operationKey !== 'sourceMaterial' ||
      owner.actionId !== 'invoke'
    )
      throw new Error('GitHub publication requires its authenticated owner operation');
    await owner.assertCurrent();
    owner.signal.throwIfAborted();
    const input = inputSchema.parse(unsafe).input;
    if (!input.operation)
      return {
        render: 'status',
        data: { kind: 'project_source_sharing' },
        label:
          'Share an exact registered PR or Issue from a Collective Project. Only explicitly shared sources can be read there.',
      };
    const { action, publication } = input.operation;
    const source = parseGitHubMaterialSource(publication.sourceId);
    const key =
      'github.source-publication.v1.' +
      hash(JSON.stringify([owner.userId, owner.pluginInstanceId, publication.publicationId]));
    const entry = await deps.storage.get(key),
      receipt = entry ? receiptSchema.parse(entry.value) : undefined;
    if (
      receipt &&
      (!isDeepStrictEqual(receipt.publication, publication) ||
        receipt.ownerUserId !== owner.userId ||
        receipt.pluginInstanceId !== owner.pluginInstanceId)
    )
      throw new Error('GitHub publication scope changed');
    if (!receipt && action === 'read') return absent('not_published');
    if (!(await deps.allowed(source.repo))) return absent('access_revoked');
    const current = async () => {
      await owner.assertCurrent();
      owner.signal.throwIfAborted();
      if (!(await deps.allowed(source.repo))) throw new Error('Repository permission changed');
    };
    try {
      const token = await deps.token(),
        signal = AbortSignal.any([owner.signal, AbortSignal.timeout(8_000)]);
      const read = async (path: string) => {
        await current();
        const { stdout } = await executeGitHubRequest(['api', path, '--hostname', 'github.com'], {
          ghToken: token,
          signal,
          timeoutMs: 8_000,
          ...(deps.execFileAsync ? { execFileAsync: deps.execFileAsync } : {}),
        });
        await current();
        return JSON.parse(stdout) as unknown;
      };
      const principal = String(z.object({ id: z.number().int().positive() }).parse(await read('user')).id);
      if (receipt && receipt.principal !== principal) return absent('access_revoked');
      const path = source.kind === 'pr' ? 'pulls' : 'issues';
      const data = subjectSchema.parse(await read(`repos/${source.repo}/${path}/${source.number}`));
      const expectedUrl = `https://github.com/${source.repo}/${source.kind === 'pr' ? 'pull' : 'issues'}/${source.number}`;
      const repo =
        source.kind === 'pr'
          ? data.base?.repo.full_name
          : data.repository_url?.replace('https://api.github.com/repos/', '');
      if (
        data.number !== source.number ||
        repo?.toLowerCase() !== source.repo ||
        data.html_url.toLowerCase() !== expectedUrl
      )
        throw new Error('GitHub provider returned a different source');
      const digest = hash(JSON.stringify([source.key, data.title, data.body, data.user.login, data.head?.sha ?? null]));
      const readAt = new Date().toISOString();
      if (!receipt) {
        await current();
        const value = receiptSchema.parse({
          v: 1,
          ownerUserId: owner.userId,
          pluginInstanceId: owner.pluginInstanceId,
          publication,
          principal,
          publishedDigest: digest,
          publishedAt: readAt,
        });
        const written = await deps.storage.compareAndSet(key, null, value);
        if (!written.applied) {
          const found = await deps.storage.get(key);
          const currentReceipt = found && receiptSchema.parse(found.value);
          if (
            !currentReceipt ||
            currentReceipt.principal !== principal ||
            !isDeepStrictEqual(currentReceipt.publication, publication)
          )
            throw new Error('GitHub publication changed concurrently');
        }
      }
      await current();
      return {
        render: 'status',
        data: {
          status: 'available',
          sourceKey: source.key,
          sourceRef: expectedUrl,
          witness: { digest, readAt, providerRevision: `${data.updated_at}${data.head ? ':' + data.head.sha : ''}` },
          material: {
            kind: source.kind,
            title: data.title.slice(0, 500),
            author: data.user.login,
            occurredAt: data.updated_at,
            url: expectedUrl,
            clauses: [{ clauseId: 'subject', text: (data.body?.trim() || data.title).slice(0, 32_000) }],
          },
        },
      };
    } catch {
      await owner.assertCurrent();
      return absent('owner_unavailable');
    }
  };
}
