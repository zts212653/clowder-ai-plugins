// Preparation-only prototype. Excluded from the package build/exports and not
// wired to any Host or module action. Production import remains unimplemented.
import { createHash } from 'node:crypto';
import type { PluginStorageHost, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import type { CommunityRepoConfig, TaskItem } from '../src/business/model/index.js';
import { GitHubWaitStorage } from '../src/typed-wait-storage.js';
import { copyLegacyRepositoryProgress, legacyRepositorySnapshotBytes,
  restoreLegacyRepositoryProgress } from '../src/legacy-repository-progress.js';

export const families = ['pr-tracking', 'issue-tracking', 'repository-config',
  'repository-progress', 'pending-outboxes', 'delivery-receipts', 'provider-history'] as const;
type Family = typeof families[number];
export interface FrozenSnapshot {
  id: string;
  coverage: Record<Family, 'complete' | 'unknown'>;
  oldWriter: 'absent' | 'active' | 'unknown';
  targetWriter: 'absent' | 'active' | 'unknown';
  unresolvedReceipts: number;
  tasks: readonly TaskItem[];
  repositories: readonly { config: CommunityRepoConfig; progress: Record<string, string> }[];
}
export interface CutoverPlan {
  sourceDigest: string;
  records: Readonly<Record<string, unknown>>;
  digest: string;
}
export const bytes = (value: unknown): string => {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return JSON.stringify(canonical(value));
};
export const digest = (value: unknown) => createHash('sha256').update(bytes(value)).digest('hex');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** This object is always fresh and in-memory. No context/storage injection or
 * production client is accepted by materializeRehearsal(). */
export class IsolatedStorage implements PluginStorageHost {
  private readonly rows = new Map<string, PluginStorageEntry>();
  private revision = 0;
  async get(k: string) { return structuredClone(this.rows.get(k)); }
  async list() { return structuredClone(Object.fromEntries(this.rows)); }
  async set(k: string, value: unknown) {
    this.rows.set(k, { revision: ++this.revision, value: structuredClone(value) });
    return { revision: this.revision };
  }
  async compareAndSet(k: string, expected: number | null, value: unknown) {
    if ((this.rows.get(k)?.revision ?? null) !== expected) return { applied: false };
    return { applied: true, ...await this.set(k, value) };
  }
  async delete(k: string, expected?: number) {
    const row = this.rows.get(k);
    if (!row || (expected !== undefined && expected !== row.revision)) return { deleted: false };
    this.rows.delete(k); return { deleted: true, revision: ++this.revision };
  }
}

function sameBinding(source: TaskItem, current: TaskItem) {
  return ['id', 'kind', 'subjectKey', 'threadId', 'ownerCatId', 'userId', 'updatedAt'].every(
    key => source[key as keyof TaskItem] === current[key as keyof TaskItem]);
}
function validateTask(task: TaskItem, current: TaskItem | undefined) {
  if (!current || !sameBinding(task, current) || !task.ownerCatId || !task.userId)
    throw new Error('Source task ownership/version must match an authoritative current binding');
  if (!['pr_tracking', 'issue_tracking'].includes(task.kind)
    || ['entrustedWork', 'deploymentWait', 'probe', 'dispatchGate'].some(key => key in task))
    throw new Error('Host obligations cannot be imported as GitHub tracking');
  const wait = task.automationState?.await;
  const outcome = task.automationState?.waitOutcome;
  if (!wait || wait.subjectRef !== task.subjectKey || !Number.isSafeInteger(wait.generation)
    || wait.generation < 1 || wait.ownerFence?.kind !== 'containing_task'
    || wait.ownerFence.generation !== wait.generation || !Number.isFinite(wait.baseline.capturedAt))
    throw new Error('A complete original fenced wait/baseline is required; fresh registration is forbidden');
  if (outcome?.delivery === 'pending' || Object.values(task.automationState ?? {}).some(
    value => value && typeof value === 'object' && 'pendingWake' in value && value.pendingWake != null))
    throw new Error('Pending Host delivery requires a verified receipt bridge before transfer');
}

/** Source completeness and writer absence are external proofs supplied by the
 * original owner, not facts established by hashing client input. Unknown is a
 * hard refusal. The current live snapshot is NOT complete and must be refused. */
export async function prepareCutover(snapshot: FrozenSnapshot, expectedSourceDigest: string,
  currentBindings: readonly TaskItem[]): Promise<CutoverPlan> {
  if (digest(snapshot) !== expectedSourceDigest) throw new Error('Frozen source digest mismatch');
  if (Buffer.byteLength(bytes(snapshot)) > 2 * 1024 * 1024 || snapshot.tasks.length > 1000
    || snapshot.repositories.length > 50) throw new Error('Snapshot exceeds bounded preparation limits');
  if (families.some(f => snapshot.coverage[f] !== 'complete')) throw new Error('Incomplete authoritative source coverage');
  if (snapshot.oldWriter !== 'absent' || snapshot.targetWriter !== 'absent') throw new Error('A single paused-writer cut is required');
  if (!Number.isSafeInteger(snapshot.unresolvedReceipts) || snapshot.unresolvedReceipts !== 0)
    throw new Error('Unresolved delivery receipt namespace');
  const subjects = new Set<string>(), ids = new Set<string>();
  for (const task of snapshot.tasks) {
    validateTask(task, currentBindings.find(row => row.id === task.id));
    if (ids.has(task.id) || subjects.has(task.subjectKey!)) throw new Error('Duplicate task or subject');
    ids.add(task.id); subjects.add(task.subjectKey!);
  }
  const shadow = new IsolatedStorage();
  const tasks = new GitHubWaitStorage(shadow);
  // Do not call registerPrWait/preparePrWait: those freeze a new baseline.
  for (const task of snapshot.tasks) await tasks.create(structuredClone(task));
  const repositories: Record<string, Record<string, string>> = Object.create(null);
  for (const row of snapshot.repositories) {
    const c = row.config;
    if (c.repo !== c.repo.toLowerCase() || !c.guardThreadId || !c.guardCatId || repositories[c.repo])
      throw new Error('Invalid or duplicate repository binding');
    repositories[c.repo] = row.progress;
  }
  const sourceDigest = sha(legacyRepositorySnapshotBytes(repositories));
  await copyLegacyRepositoryProgress({ protocolVersion: 1, sourceDigest, snapshot: { repositories } },
    shadow, new AbortController().signal);
  for (const row of snapshot.repositories) {
    await restoreLegacyRepositoryProgress(row.config.repo, shadow, new AbortController().signal);
    // Preserve timestamps/policy/destination; ordinary upsert generates new timestamps.
    await shadow.compareAndSet(`community.repo.${sha(row.config.repo)}`, null, structuredClone(row.config));
  }
  const records = Object.fromEntries(Object.entries(await shadow.list())
    .filter(([k]) => !k.startsWith('community.legacy-repo.')).map(([k, v]) => [k, v.value]));
  return { sourceDigest: expectedSourceDigest, records, digest: digest({ sourceDigest: expectedSourceDigest, records }) };
}

function validatePlan(plan: CutoverPlan) {
  if (digest({ sourceDigest: plan.sourceDigest, records: plan.records }) !== plan.digest)
    throw new Error('Prepared plan changed');
}
const journalKey = (plan: CutoverPlan) => `github.cutover.rehearsal.${plan.digest}`;
const rowKey = (plan: CutoverPlan, target: string) => `${journalKey(plan)}.${sha(target)}`;

/** Inert staging only. No key consumed by current collectors is written. */
export async function stageRehearsal(plan: CutoverPlan, storage: PluginStorageHost, signal: AbortSignal) {
  validatePlan(plan); signal.throwIfAborted();
  const key = journalKey(plan), existing = await storage.get(key);
  if (existing && bytes(existing.value) !== bytes({ digest: plan.digest, state: 'staging' })
    && bytes(existing.value) !== bytes({ digest: plan.digest, state: 'staged' })) throw new Error('Rehearsal was aborted or conflicted');
  // Validate every known active/staging target before the first write. A
  // different batch or a runtime writer is never silently overwritten.
  for (const [target, value] of Object.entries(plan.records)) {
    const active = await storage.get(target), staged = await storage.get(rowKey(plan, target));
    if (active) throw new Error('Target has active state; refuse a second writer');
    if (staged && bytes(staged.value) !== bytes({ target, value })) throw new Error('Staged row conflict');
  }
  if (!existing) {
    const created = await storage.compareAndSet(key, null, { digest: plan.digest, state: 'staging' });
    if (!created.applied) throw new Error('Staging admission raced; retry from the journal');
  }
  for (const [target, value] of Object.entries(plan.records)) {
    signal.throwIfAborted();
    const name = rowKey(plan, target), row = { target, value };
    const result = await storage.compareAndSet(name, null, row);
    if (!result.applied && bytes((await storage.get(name))?.value) !== bytes(row)) throw new Error('Staging raced');
  }
  const current = await storage.get(key);
  signal.throwIfAborted();
  if (current && bytes(current.value) !== bytes({ digest: plan.digest, state: 'staging' })
    && bytes(current.value) !== bytes({ digest: plan.digest, state: 'staged' })) throw new Error('Rehearsal was aborted or conflicted');
  if (!current || !await storage.compareAndSet(key, current.revision, { digest: plan.digest, state: 'staged' }).then(x=>x.applied))
    throw new Error('Staging completion raced');
  return { rows: Object.keys(plan.records).length, pollingStarted: false as const };
}

export async function abortRehearsal(plan: CutoverPlan, storage: PluginStorageHost) {
  validatePlan(plan); const key = journalKey(plan), row = await storage.get(key);
  if (!row) return;
  if (!(await storage.compareAndSet(key, row.revision, { digest: plan.digest, state: 'aborted' })).applied)
    throw new Error('Abort raced');
  // Keep inert evidence; never delete a current provider key or source record.
}

/** Materialization is deliberately confined to newly allocated memory. An
 * ordinary owner-authenticated module import/commit action does not yet exist. */
export async function materializeRehearsal(plan: CutoverPlan) {
  validatePlan(plan); const shadow = new IsolatedStorage();
  for (const [key, value] of Object.entries(plan.records)) await shadow.compareAndSet(key, null, value);
  return shadow;
}
