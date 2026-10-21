import type { CommunityRepoConfig } from './business/model/index.js';
import type { MigrationSource } from './migration-source.js';
import type { LegacyReadPort, LegacySourceScope } from './operational-source.js';
import { hash, number, ownedThread, scalar, scan, strings } from './operational-source-values.js';

export async function legacyRepositories(reader: LegacyReadPort, scope: LegacySourceScope, signal: AbortSignal) {
  const key = scope.keyPrefix + 'community:repo-configs:index',
    count = number(await reader.read('SCARD', key));
  if (count > 50) throw new Error('Repository index exceeds source scope');
  const names = strings(await reader.read('SMEMBERS', key)).sort();
  if (names.length !== count || names.some((repo) => !scope.repositories.includes(repo)))
    throw new Error('Repository scope is incomplete; no alias migration permitted');
  const repositories: MigrationSource['repositories'][number][] = [],
    gaps: string[] = [];
  for (const repo of names) {
    signal.throwIfAborted();
    const raw = await hash(reader, scope.keyPrefix + 'community:repo-config:' + repo, [
      'repo',
      'guardThreadId',
      'guardCatId',
      'reviewMode',
      'cloudReviewPolicy',
      'createdAt',
      'updatedAt',
    ]);
    if (raw.repo !== repo || !raw.guardThreadId || !(await ownedThread(reader, scope, raw.guardThreadId)))
      throw new Error('Repository owner/configuration unavailable');
    const binding = await hash(reader, scope.keyPrefix + 'connector-binding:github-repo-event:' + repo, [
      'connectorId',
      'externalChatId',
      'threadId',
      'userId',
    ]);
    if (
      binding.connectorId !== 'github-repo-event' ||
      binding.externalChatId !== repo ||
      !binding.threadId || !(await ownedThread(reader, scope, binding.threadId)) ||
      binding.userId !== scope.ownerUserId
    )
      throw new Error('Original repository route binding unavailable or outside owner scope');
    const config = {
      ...raw,
      createdAt: Number(raw.createdAt),
      updatedAt: Number(raw.updatedAt),
    } as unknown as CommunityRepoConfig;
    const progress: Record<string, string> = Object.create(null);
    for (const name of [
      `f141:baseline:${repo}`,
      `community:repo-comment:cursor:${repo}`,
      ...(await scan(reader, scope.keyPrefix, `f141:notified:${repo}#*`)),
    ]) {
      const value = scalar(await reader.read('GET', scope.keyPrefix + name));
      if (value !== null) progress[name] = value;
    }
    const commentOverlapEventIds = await scan(reader, scope.keyPrefix, `comment:${repo}#*`, 'community:events:seen');
    if (commentOverlapEventIds.length > 1000)
      throw new Error('Source comment dedup exceeds the supported import bound');
    repositories.push({ config, progress, commentOverlapEventIds,
      notificationRoute: { threadId: binding.threadId, userId: binding.userId } });
    for (const kind of ['pr', 'issue']) {
      const pattern = `msg:idem:${scope.ownerUserId}:*:github-repo-event:reconciliation-${kind}-${repo}#*`;
      for (const key of await scan(reader, scope.keyPrefix, pattern)) {
        const prefix = `msg:idem:${scope.ownerUserId}:${binding.threadId}:github-repo-event:reconciliation-${kind}-${repo}#`;
        if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length)))
          throw new Error('Reconciliation route differs from approved configuration');
        const messageId = scalar(await reader.read('GET', scope.keyPrefix + key));
        if (messageId && !progress[`f141:notified:${repo}#${kind}-${key.slice(prefix.length)}`]) gaps.push(key);
      }
    }
  }
  const claims: Record<string, string> = Object.create(null);
  for (const name of await scan(reader, scope.keyPrefix, 'f141:delivery:*')) {
    const value = scalar(await reader.read('GET', scope.keyPrefix + name));
    if (value !== null && !['pending', 'confirmed'].includes(value))
      throw new Error('Unknown repository delivery claim');
    if (value !== null) claims[name] = value;
  }
  return {
    repositories,
    claims: { ...claims, ...Object.fromEntries(gaps.map((k) => [k, 'message-marker-gap'])) },
    unresolved: gaps.length + Object.values(claims).filter((value) => value === 'pending').length,
  };
}
