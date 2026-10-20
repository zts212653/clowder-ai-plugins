import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const communityProgressKey = (kind: string, id: string) => `community.${kind}.${digest(id)}`;
const stageKey = (repo: string) => communityProgressKey('legacy-repo', repo);
const rawBytes = (raw: Record<string, string>) => '{' + Object.keys(raw).sort()
  .map(key => JSON.stringify(key) + ':' + JSON.stringify(raw[key])).join(',') + '}';
export const legacyRepositorySnapshotBytes = (repositories: Record<string, Record<string, string>>) =>
  '{"repositories":{' + Object.keys(repositories).sort().map(repo => JSON.stringify(repo) + ':' + rawBytes(repositories[repo]!)).join(',') + '}}';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository copy requires objects');
  return value as Record<string, unknown>;
}
function repository(value: string) {
  if (value.length > 256 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new TypeError('invalid repository');
  return value.toLowerCase();
}

/** Frozen Host key formats. Neither configuration, destinations nor any
 * assignment/governance data are accepted as progress. Raw strings retain
 * their original bytes for the envelope digest. */
function decodeRaw(repo: string, value: unknown) {
  const raw = object(value), entries = Object.entries(raw);
  if (entries.length > 5002) throw new TypeError('repository progress exceeds 5000 notifications');
  const writes: Array<{ key: string; value: string | boolean }> = [];
  for (const [key, value] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (typeof value !== 'string') throw new TypeError('raw progress values must be strings');
    if (key === `f141:baseline:${repo}`) {
      if (value !== '1') throw new TypeError('invalid baseline');
      writes.push({ key: communityProgressKey('scan-baseline', repo), value: true });
      continue;
    }
    if (key === `community:repo-comment:cursor:${repo}`) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new TypeError('invalid comment cursor');
      }
      const canonical = new Date(value).toISOString();
      if (canonical !== value && canonical.replace('.000Z', 'Z') !== value) throw new TypeError('invalid calendar timestamp');
      writes.push({ key: communityProgressKey('comment-cursor', repo), value });
      continue;
    }
    const prefix = `f141:notified:${repo}#`;
    const match = key.startsWith(prefix) ? /^(pr|issue)-([1-9]\d*)$/.exec(key.slice(prefix.length)) : null;
    if (!match || value !== '1' || !Number.isSafeInteger(Number(match[2]))) throw new TypeError('unsupported repository progress key/value');
    writes.push({ key: communityProgressKey('scan-notified', `${match[1]}:${repo}#${match[2]}`), value: true });
  }
  if (writes.filter(row => row.key.startsWith('community.scan-notified.')).length > 5000) throw new TypeError('repository progress exceeds 5000 notifications');
  return { raw: raw as Record<string, string>, writes };
}

function decodeEnvelope(value: unknown) {
  const envelope = object(value);
  if (Object.keys(envelope).some(key => !['protocolVersion', 'sourceDigest', 'snapshot'].includes(key)) ||
    envelope.protocolVersion !== 1 || typeof envelope.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sourceDigest)) {
    throw new TypeError('invalid repository progress envelope');
  }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 256 * 1024) throw new TypeError('repository copy exceeds 256 KiB');
  const snapshot = object(envelope.snapshot);
  if (Object.keys(snapshot).length !== 1 || !Object.hasOwn(snapshot, 'repositories')) throw new TypeError('unsupported repository snapshot');
  const repositories = object(snapshot.repositories);
  if (Object.keys(repositories).length > 50) throw new TypeError('repository copy exceeds 50 repositories');
  const subjects = new Set<string>(), raws: Record<string, Record<string, string>> = Object.create(null);
  const rows = Object.keys(repositories).sort().map(sourceRepo => {
    const repo = repository(sourceRepo);
    if (subjects.has(repo)) throw new TypeError('duplicate repository');
    subjects.add(repo);
    // Host stores repo progress with its supplied repo spelling. Require the
    // canonical key scope rather than guessing case aliases or foreign keys.
    const decoded = decodeRaw(repo, repositories[sourceRepo]); raws[sourceRepo] = decoded.raw;
    return { schemaVersion: 1 as const, repo, strings: decoded.raw };
  });
  if (digest(legacyRepositorySnapshotBytes(raws)) !== envelope.sourceDigest) throw new TypeError('repository snapshot digest mismatch');
  return { rows, sourceDigest: envelope.sourceDigest };
}

function stored(value: unknown, repo: string) {
  const row = object(value);
  if (row.schemaVersion !== 1 || row.repo !== repo || Object.keys(row).some(key => !['schemaVersion', 'repo', 'strings'].includes(key))) {
    throw new TypeError('invalid persisted repository copy');
  }
  return decodeRaw(repo, row.strings);
}

/** Stage insert-only provider progress. This never creates an active config,
 * binds a thread, fetches GitHub, posts messages or changes any Host record. */
export async function copyLegacyRepositoryProgress(value: unknown, storage: PluginStorageHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const { rows, sourceDigest } = decodeEnvelope(value);
  const counts = { imported: 0, identical: 0, preserved: 0 };
  for (const row of rows) {
    signal.throwIfAborted();
    if (await storage.get(communityProgressKey('repo', row.repo))) { counts.preserved++; continue; }
    const result = await storage.compareAndSet(stageKey(row.repo), null, row);
    if (result.applied) { counts.imported++; continue; }
    const existing = await storage.get(stageKey(row.repo));
    if (!existing) throw new Error('repository copy changed concurrently');
    const previous = stored(existing.value, row.repo);
    if (rawBytes(previous.raw) === rawBytes(row.strings)) counts.identical++;
    else counts.preserved++;
  }
  return { render: 'status' as const, data: { protocolVersion: 1, sourceDigest, ...counts,
    repositoryCount: rows.length, pollingStarted: false, scope: 'staged-provider-progress-only' } };
}

/** Called inside the runtime's registration queue, AFTER Host access/binding
 * checks and BEFORE publishing the active config. A crash leaves only inert
 * partial progress; retry fills missing keys without rolling any frontier back. */
export async function restoreLegacyRepositoryProgress(repo: string, storage: PluginStorageHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const canonical = repository(repo);
  if (await storage.get(communityProgressKey('repo', canonical))) return;
  const entry = await storage.get(stageKey(canonical));
  if (!entry) return;
  const { writes } = stored(entry.value, canonical);
  for (const row of writes) {
    signal.throwIfAborted();
    await storage.compareAndSet(row.key, null, row.value);
  }
}
