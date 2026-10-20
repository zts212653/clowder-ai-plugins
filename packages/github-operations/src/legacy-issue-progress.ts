import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const stageKey = (subject: string) => 'github.legacy-issue-progress.' + hash(subject);
const trackingKey = (subject: string) => 'github.tracking.v1.' + hash(subject);
const rawBytes = (raw: Record<string, string>) => '{' + Object.keys(raw).sort()
  .map(key => JSON.stringify(key) + ':' + JSON.stringify(raw[key])).join(',') + '}';
export const legacyIssueProgressBytes = (tasks: Record<string, Record<string, string>>) =>
  '{"tasks":{' + Object.keys(tasks).sort().map(id => JSON.stringify(id) + ':' + rawBytes(tasks[id]!)).join(',') + '}}';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('issue progress requires objects');
  return value as Record<string, unknown>;
}
function cursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('invalid issue cursor');
  return value as number;
}
interface Progress { schema: 1; subject: string; collected: number; delivered: number }
function stored(value: unknown, subject: string): Progress {
  const row = object(value);
  if (row.schema !== 1 || row.subject !== subject || Object.keys(row).some(key => !['schema', 'subject', 'collected', 'delivered'].includes(key))) {
    throw new TypeError('invalid stored issue progress');
  }
  const collected = cursor(row.collected), delivered = cursor(row.delivered);
  if (delivered > collected) throw new TypeError('delivered cursor exceeds collected cursor');
  return { schema: 1, subject, collected, delivered };
}

// Frozen RedisTaskCodec hash fields. Identity/routing prose is never persisted.
const taskFields = new Set(['id', 'kind', 'threadId', 'subjectKey', 'title', 'ownerCatId', 'status', 'why',
  'createdBy', 'createdAt', 'updatedAt', 'userId', 'probe', 'resolveMode', 'automationState', 'deploymentWait',
  'relatedFeatureId', 'detectedFeatureIds', 'dispatchGate', 'entrustedWork']);
function decodeTask(id: string, value: unknown): { raw: Record<string, string>; progress: Progress } {
  const raw = object(value);
  if (!id || id.length > 256 || raw.id !== id || raw.kind !== 'issue_tracking' || !['todo', 'doing'].includes(raw.status as string) ||
    Object.entries(raw).some(([key, value]) => !taskFields.has(key) || typeof value !== 'string')) throw new TypeError('unsupported legacy issue task');
  if (['probe', 'resolveMode', 'deploymentWait', 'dispatchGate', 'entrustedWork'].some(key => raw[key] !== undefined && raw[key] !== '')) {
    throw new TypeError('Host obligation must be settled before issue copy');
  }
  const match = typeof raw.subjectKey === 'string' && /^issue:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(raw.subjectKey);
  if (!match || match[1]!.length > 256 || !Number.isSafeInteger(Number(match[2]))) throw new TypeError('invalid issue subject');
  const subject = `issue:${match[1]!.toLowerCase()}#${match[2]}`;
  if (typeof raw.automationState !== 'string') throw new TypeError('issue automation state required');
  const automation = object(JSON.parse(raw.automationState));
  if (Object.keys(automation).some(key => key !== 'issue')) throw new TypeError('Host automation obligations are not transferable');
  const issue = object(automation.issue);
  if (Object.keys(issue).some(key => !['lastCommentCursor', 'lastDeliveredCursor', 'lastNotifiedAt', 'issueState', 'pendingWake'].includes(key))) {
    throw new TypeError('unsupported issue progress field');
  }
  if (issue.pendingWake !== undefined && issue.pendingWake !== null) throw new TypeError('Host pending wake must be settled');
  if (issue.issueState !== undefined && issue.issueState !== 'open') throw new TypeError('terminal issue must be settled by Host');
  if (issue.lastNotifiedAt !== undefined) cursor(issue.lastNotifiedAt);
  const collected = cursor(issue.lastCommentCursor);
  // Matches IssueCommentTaskSpec's pre-advance single-cursor fallback.
  const delivered = issue.lastDeliveredCursor === undefined ? collected : cursor(issue.lastDeliveredCursor);
  return { raw: raw as Record<string, string>, progress: stored({ schema: 1, subject, collected, delivered }, subject) };
}

/** No activation, destinations, GitHub calls or notifications. Entire batch
 * validates before the first insert-only CAS; partial failure is retryable. */
export async function copyLegacyIssueProgress(value: unknown, storage: PluginStorageHost, signal: AbortSignal,
  serialize: (key: string, work: () => Promise<void>) => Promise<void> = async (_key, work) => work()) {
  signal.throwIfAborted();
  const envelope = object(value);
  if (Buffer.byteLength(JSON.stringify(envelope)) > 256 * 1024) throw new TypeError('issue copy exceeds 256 KiB');
  if (envelope.protocolVersion !== 1 || typeof envelope.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sourceDigest) ||
    Object.keys(envelope).some(key => !['protocolVersion', 'sourceDigest', 'snapshot'].includes(key))) throw new TypeError('invalid issue progress envelope');
  const snapshot = object(envelope.snapshot);
  if (Object.keys(snapshot).length !== 1 || !Object.hasOwn(snapshot, 'tasks')) throw new TypeError('invalid issue progress snapshot');
  const tasks = object(snapshot.tasks), ids = Object.keys(tasks).sort();
  if (ids.length > 100) throw new TypeError('issue copy exceeds 100 tasks');
  const raws: Record<string, Record<string, string>> = Object.create(null), subjects = new Set<string>();
  const rows = ids.map(id => {
    const { raw, progress } = decodeTask(id, tasks[id]); raws[id] = raw;
    if (subjects.has(progress.subject)) throw new TypeError('duplicate issue subject');
    subjects.add(progress.subject); return progress;
  });
  if (hash(legacyIssueProgressBytes(raws)) !== envelope.sourceDigest) throw new TypeError('issue snapshot digest mismatch');
  const counts = { imported: 0, identical: 0, preserved: 0 };
  for (const row of rows) {
    await serialize(trackingKey(row.subject), async () => {
      signal.throwIfAborted();
      if (await storage.get(trackingKey(row.subject))) { counts.preserved++; return; }
      const result = await storage.compareAndSet(stageKey(row.subject), null, row);
      if (result.applied) { counts.imported++; return; }
      const old = await storage.get(stageKey(row.subject));
      if (!old) throw new Error('issue copy changed concurrently');
      const previous = stored(old.value, row.subject);
      if (previous.collected === row.collected && previous.delivered === row.delivered) counts.identical++;
      else counts.preserved++;
    });
  }
  return { render: 'status' as const, data: { protocolVersion: 1, sourceDigest: envelope.sourceDigest,
    ...counts, taskCount: rows.length, pollingStarted: false, scope: 'staged-issue-delivery-progress-only' } };
}

/** Only used on first registration after Host get/bind, before active-record CAS.
 * Existing registrations, including retired ones, never reapply a stale copy. */
export async function readLegacyIssueProgress(subject: string, storage: PluginStorageHost): Promise<Progress | undefined> {
  const entry = await storage.get(stageKey(subject));
  return entry ? stored(entry.value, subject) : undefined;
}
