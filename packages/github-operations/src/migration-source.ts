import { createHash } from 'node:crypto';
import type { TaskItem, CommunityRepoConfig } from './business/model/index.js';
import { exportedTaskSchema, exportedRepoSchema, exportedReceiptSchema } from './migration-source-schema.js';

export const sourceFamilies = ['tracking', 'repositories', 'progress', 'pending-receipts', 'authority-retention'] as const;
export type SourceFamily = typeof sourceFamilies[number];
export interface DeliveryReceipt {
  readonly taskId: string;
  readonly outcomeId?: string;
  readonly messageId?: string;
  readonly sourceRef: string;
  readonly disposition: 'delivered' | 'not-delivered' | 'ambiguous';
  readonly messageAppended: boolean;
  readonly wakeAccepted: boolean;
}
export interface MigrationSource {
  readonly v: 1;
  readonly id: string;
  readonly userId: string;
  readonly sourceRef: string;
  readonly capturedAt: number;
  readonly oldWriter: 'absent' | 'active' | 'unknown';
  readonly coverage: Readonly<Record<SourceFamily, 'complete' | 'unknown'>>;
  readonly tasks: readonly TaskItem[];
  readonly repositories: readonly { config: CommunityRepoConfig; progress: Record<string, string>;
    /** Original connector Inbox, distinct from the community guard assignment. */
    notificationRoute?: { readonly threadId: string; readonly userId: string };
    /** Only exact seen IDs in the cursor overlap, no provider bodies or old grants. */
    commentOverlapEventIds: readonly string[] }[];
  readonly receipts: readonly DeliveryReceipt[];
  /** Opaque references only. Old registration/governance authority stays at source. */
  readonly retainedAuthorityRefs: readonly string[];
  readonly unresolvedRepositoryDeliveries: number;
}
export function canonicalBytes(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
export const sourceDigest = (value: unknown) => createHash('sha256').update(canonicalBytes(value)).digest('hex');
export const migrationKey = (value: string) => createHash('sha256').update(value).digest('hex');
export function assertSourceEnvelope(value: unknown): asserts value is MigrationSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['v','id','userId','sourceRef','capturedAt','oldWriter','coverage','tasks','repositories','receipts','retainedAuthorityRefs','unresolvedRepositoryDeliveries'].includes(key)))
    throw new Error('Only bounded GitHub recovery families may be exported');
  const cut = value as MigrationSource;
  if (cut.v !== 1 || typeof cut.userId !== 'string' || !cut.userId || typeof cut.sourceRef !== 'string' || !cut.sourceRef
    || typeof cut.id !== 'string' || !cut.id || !Number.isSafeInteger(cut.capturedAt) || cut.capturedAt < 0
    || !cut.coverage || sourceFamilies.some(f => cut.coverage[f] !== 'complete') || cut.oldWriter !== 'absent'
    || Object.keys(cut.coverage).some(key => !(sourceFamilies as readonly string[]).includes(key))
    || !Array.isArray(cut.tasks) || !Array.isArray(cut.repositories) || !Array.isArray(cut.receipts)
    || cut.tasks.length > 1000 || cut.repositories.length > 50 || cut.receipts.length > 1000
    || Buffer.byteLength(canonicalBytes(cut)) > 2 * 1024 * 1024) throw new Error('Incomplete or oversized GitHub source');
  if (cut.tasks.some(task => !exportedTaskSchema.safeParse(task).success)) throw new Error('Invalid GitHub tracking source');
  if (new Set(cut.tasks.map(task => task.id)).size !== cut.tasks.length) throw new Error('Duplicate GitHub source task');
  if (cut.repositories.some(row => !exportedRepoSchema.safeParse(row.config).success)) throw new Error('Invalid GitHub repository source');
  for (const row of cut.repositories) {
    if (Object.keys(row).some(key => !['config','progress','commentOverlapEventIds','notificationRoute'].includes(key))
      || !row.progress || typeof row.progress !== 'object' || Array.isArray(row.progress) || !Array.isArray(row.commentOverlapEventIds))
      throw new Error('Only GitHub repository progress metadata may be exported');
    if (row.notificationRoute !== undefined && (!row.notificationRoute || typeof row.notificationRoute !== 'object'
      || Array.isArray(row.notificationRoute) || Object.keys(row.notificationRoute).some(key => !['threadId','userId'].includes(key))
      || typeof row.notificationRoute.threadId !== 'string' || !/^[A-Za-z0-9_.@-]{1,200}$/.test(row.notificationRoute.threadId)
      || row.notificationRoute.userId !== cut.userId)) throw new Error('Original repository notification route ownership is invalid');
    const repo = row.config.repo, notified = `f141:notified:${repo}#`;
    if (Object.entries(row.progress).some(([key,value]) => typeof value !== 'string' || !(key === `f141:baseline:${repo}`
      || key === `community:repo-comment:cursor:${repo}` || key.startsWith(notified) && /^(pr|issue)-[1-9]\d*$/.test(key.slice(notified.length))))
      || row.commentOverlapEventIds.some((id: unknown) => typeof id !== 'string' || !id.startsWith(`comment:${repo}#`)
        || !/^comment:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*:[1-9]\d*$/.test(id))) throw new Error('Unrelated source progress or event field');
  }
  if (cut.receipts.some(receipt => !exportedReceiptSchema.safeParse(receipt).success)
    || !Array.isArray(cut.retainedAuthorityRefs) || cut.retainedAuthorityRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 500))
    throw new Error('Invalid GitHub receipt source');
}

export interface ReadOnlySourcePort {
  /** Must enumerate this exact owner/scope completely, or return unknown. No write port exists. */
  read(signal: AbortSignal): Promise<MigrationSource>;
}

/** Two matching bounded reads are a stability check, not authentication or a
 * transaction over a live writer. The original writer must already be absent. */
export async function freezeGitHubSource(port: ReadOnlySourcePort, signal: AbortSignal) {
  signal.throwIfAborted();
  const first = structuredClone(await port.read(signal));
  signal.throwIfAborted();
  const second = structuredClone(await port.read(signal));
  signal.throwIfAborted();
  for (const cut of [first, second]) {
    assertSourceEnvelope(cut);
  }
  // Read timestamps may differ; source identity, membership and every value must not.
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const stable = (cut: MigrationSource) => ({ ...cut, capturedAt: 0,
    tasks: [...cut.tasks].sort((a,b) => compare(a.id,b.id)), repositories: [...cut.repositories].sort((a,b) => compare(a.config.repo,b.config.repo)),
    receipts: [...cut.receipts].sort((a,b) => compare(`${a.taskId}:${a.outcomeId ?? ''}`,`${b.taskId}:${b.outcomeId ?? ''}`)),
    retainedAuthorityRefs: [...cut.retainedAuthorityRefs].sort(compare) });
  if (sourceDigest(stable(first)) !== sourceDigest(stable(second))) throw new Error('GitHub source changed during freeze');
  return { snapshot: second, digest: sourceDigest(second), counts: {
    tasks: second.tasks.length, repositories: second.repositories.length, receipts: second.receipts.length,
  } };
}
