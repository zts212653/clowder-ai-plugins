import type { FeatureContext, PluginActionContext, PluginActionHandler } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { assertBinding, isExpired, planMigration, type MigrationPlan, type MigrationTask } from './migration-plan.js';
import { canonicalBytes, migrationKey, sourceDigest } from './migration-source.js';
import { importedWait, importedProjectionMatches } from './migration-wait.js';
import { inspectGitHubSource } from './migration-source-inspection.js';

const CONTROL = 'github.migration.control.v1';
type Phase = 'staging' | 'staged' | 'committing' | 'committed' | 'released' | 'aborted';
interface Journal {
  v: 1; epoch: number; userId: string; sourceDigest: string; planDigest: string; phase: Phase;
  targets: readonly string[];
  tasks: readonly { id: string; mode: MigrationTask['mode']; target: string }[];
}
const stagedKey = (digest: string, target: string) => `github.migration.stage.${digest}.${migrationKey(target)}`;
const ackKey = (digest: string, id: string) => `github.migration.binding.${digest}.${migrationKey(id)}`;
type Check = () => Promise<void>;
interface BindingAck { state: 'intent' | 'bound'; updatedAt: number; status: TaskItem['status'] }
/** A single import, held until all current Host bindings agree. No provider,
 * secret, message, Task create, owner reassignment or timeline port is used. */
export class GitHubMigrationRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private mode?: 'normal' | 'import-only';
  constructor(private readonly context: FeatureContext, private readonly now = Date.now) {}
  private async importOnly() {
    if (this.mode !== undefined) return this.mode === 'import-only';
    const mode = await this.context.config.get('recoveryMode');
    if (mode !== undefined && mode !== 'normal' && mode !== 'import-only') throw new Error('Invalid recoveryMode; keep import hold');
    // Set before activation. Do not reenter configuration/provider workflows
    // from every ordinary action; a mode change requires a fresh activation.
    this.mode = mode ?? 'normal'; return this.mode === 'import-only';
  }
  async held() {
    const importOnly = await this.importOnly();
    const journal = await this.journal();
    if (journal) return journal.phase !== 'released';
    return importOnly;
  }
  guard(actions: Readonly<Record<string, PluginActionHandler>>) {
    return Object.fromEntries(Object.entries(actions).map(([method, handler]) => [method,
      method.startsWith('github.migration.') ? handler : (async (...args: Parameters<PluginActionHandler>) => {
        if (await this.held()) throw new Error('GitHub import-only hold: collection and ordinary actions are paused');
        return handler(...args);
      }) satisfies PluginActionHandler]));
  }
  private async journal(): Promise<Journal | undefined> {
    const entry = await this.context.storage.get(CONTROL);
    if (!entry) return;
    const j = entry.value as Journal;
    if (j.v !== 1 || !Number.isSafeInteger(j.epoch) || j.epoch < 1 || !['staging','staged','committing','committed','released','aborted'].includes(j.phase)
      || !j.userId || !Array.isArray(j.targets) || !Array.isArray(j.tasks)) throw new Error('Invalid migration journal; keep hold');
    return j;
  }
  private serialize<T>(check: Check, work: () => Promise<T>) {
    const result = this.queue.catch(() => undefined).then(async () => {
      if (this.stopped) throw new Error('Migration stopped'); await check(); return work();
    });
    this.queue = result; return result;
  }
  private async change(journal: Journal, phase: Phase, check: Check) {
    const row = await this.context.storage.get(CONTROL);
    if (!row || canonicalBytes(row.value) !== canonicalBytes(journal)) throw new Error('Migration journal changed');
    await check();
    if (!(await this.context.storage.compareAndSet(CONTROL, row.revision, { ...journal, phase })).applied)
      throw new Error('Migration journal raced; recover from durable state');
  }
  private async plan(j: Journal): Promise<MigrationPlan> {
    const records: Record<string, unknown> = Object.create(null);
    for (const target of j.targets) {
      const staged = await this.context.storage.get(stagedKey(j.planDigest, target));
      if (!staged) throw new Error('Stage is incomplete; repeat stage with the same frozen source');
      records[target] = staged.value;
    }
    const tasks = j.tasks.map(row => ({ mode: row.mode, task: (records[row.target] as { task: TaskItem }).task }));
    const plan = { sourceDigest: j.sourceDigest, records, tasks };
    if (sourceDigest(plan) !== j.planDigest) throw new Error('Staged source changed');
    return { ...plan, digest: j.planDigest };
  }
  async owner(operation: string, value: unknown, userId: string, assertOwner: Check) {
    const check = async () => { if (this.stopped) throw new Error('Migration stopped'); await assertOwner(); };
    return this.serialize(check, async () => {
      const input = value as { snapshot?: unknown; expectedDigest?: string } | null;
      const j = await this.journal();
      if (j && j.userId !== userId) throw new Error('Migration belongs to another installation owner');
      if (operation === 'status') return this.status(j);
      if (operation === 'source') return inspectGitHubSource(this.context, check);
      if (!await this.importOnly()) throw new Error('Configure import-only hold before importing');
      if (operation === 'stage') return this.stage(input?.snapshot, input?.expectedDigest ?? '', userId, j, check);
      if (!j || input?.expectedDigest !== j.planDigest) throw new Error('Exact migration plan digest required');
      if (operation === 'abort') {
        if (!['staging','staged','aborted'].includes(j.phase)) throw new Error('Import writes started; keep hold and recover instead of restoring an old snapshot');
        if (j.phase !== 'aborted') await this.change(j, 'aborted', check);
        return this.status(await this.journal());
      }
      if (j.phase === 'aborted') throw new Error('Migration was aborted; no completion or release is permitted');
      if (operation === 'commit' || operation === 'recover') return this.commit(j, check);
      if (operation === 'release') {
        if (j.phase === 'released') return this.status(j);
        if (j.phase !== 'committed') throw new Error('Full import and current Host bindings must be committed first');
        if ((await this.verify(await this.plan(j), j, check)).length) throw new Error('Current Host binding/projection is incomplete');
        await this.change(j, 'released', check); return this.status(await this.journal());
      }
      throw new Error('Unsupported migration operation');
    });
  }
  private status(j?: Journal) {
    return { data: { phase: j?.phase ?? 'holding', planDigest: j?.planDigest ?? null,
      tasks: j?.tasks.length ?? 0, records: j?.targets.length ?? 0, collectionReleased: j?.phase === 'released',
      counts: { typed: j?.tasks.filter(t => t.mode === 'typed').length ?? 0,
        legacyIssues: j?.tasks.filter(t => t.mode === 'legacy-issue').length ?? 0,
        historical: j?.tasks.filter(t => t.mode === 'history').length ?? 0 } } };
  }
  private async stage(snapshot: unknown, digest: string, userId: string, j: Journal | undefined, check: Check) {
    if (j && !['staging','staged','aborted'].includes(j.phase)) throw new Error('Existing import cannot be replaced');
    const plan = await planMigration(snapshot, digest, this.context, userId, this.now());
    await check();
    if (j?.phase === 'aborted' && j.planDigest === plan.digest) throw new Error('Aborted plan cannot be revived; explicitly freeze a new cut');
    if (j && j.phase !== 'aborted' && j.planDigest !== plan.digest) throw new Error('Conflicting frozen source');
    for (const target of Object.keys(plan.records)) {
      if (Buffer.byteLength(canonicalBytes(plan.records[target])) > 1024 * 1024) throw new Error('Import row exceeds the Host state value bound');
      if (await this.context.storage.get(target)) throw new Error('Existing active target; refuse a second writer');
      const staged = await this.context.storage.get(stagedKey(plan.digest, target));
      if (staged && canonicalBytes(staged.value) !== canonicalBytes(plan.records[target])) throw new Error('Staged row conflict');
    }
    if (!j || j.phase === 'aborted') {
      const previous = await this.context.storage.get(CONTROL);
      if (canonicalBytes(previous?.value) !== canonicalBytes(j)) throw new Error('Stage owner journal changed');
      if (j) {
        await check();
        await this.context.storage.compareAndSet(`github.migration.aborted.${j.planDigest}`, null, j);
      }
      j = { v: 1, epoch: (j?.epoch ?? 0) + 1, userId, sourceDigest: digest, planDigest: plan.digest, phase: 'staging', targets: Object.keys(plan.records),
        tasks: plan.tasks.map(row => ({ id: row.task.id, mode: row.mode, target: Object.keys(plan.records).find(key =>
          (plan.records[key] as { task?: TaskItem })?.task?.id === row.task.id)! })) };
      if (Buffer.byteLength(canonicalBytes(j)) > 1024 * 1024) throw new Error('Import journal exceeds the Host state value bound');
      await check();
      if (!(await this.context.storage.compareAndSet(CONTROL, previous?.revision ?? null, j)).applied) throw new Error('Stage admission raced');
    }
    for (const [target, record] of Object.entries(plan.records)) {
      await check(); const key = stagedKey(plan.digest, target);
      if (!(await this.context.storage.compareAndSet(key, null, record)).applied
        && canonicalBytes((await this.context.storage.get(key))?.value) !== canonicalBytes(record)) throw new Error('Staging raced');
    }
    if (j.phase !== 'staged') await this.change(j, 'staged', check);
    return this.status(await this.journal());
  }
  private async verify(plan: MigrationPlan, j: Journal, check: Check) {
    const missing: string[] = [];
    for (const row of plan.tasks) {
      if (row.mode === 'history') continue;
      await check();
      const ack = await this.context.storage.get(ackKey(j.planDigest, row.task.id));
      const receipt = ack?.value as BindingAck | undefined;
      const version = row.mode === 'typed' && receipt?.state === 'bound' ? receipt.updatedAt : row.task.updatedAt;
      // An in-flight first binding may already have committed at the Host. It
      // needs an authenticated bind replay, never background reconstruction.
      if (row.mode === 'typed' && receipt?.state === 'intent') { missing.push(row.task.id); continue; }
      const host = await assertBinding(this.context, row.task, j.userId, version, receipt?.state === 'bound' ? receipt.status : row.task.status);
      if (row.mode === 'typed') {
        if (isExpired(row.task, this.now())) throw new Error('Wait expired during import; keep hold for an explicit historical recut');
        if (!receipt || !importedProjectionMatches(host, row.task, this.context.pluginInstanceId)) missing.push(row.task.id);
      }
    }
    return missing;
  }
  private async commit(j: Journal, check: Check) {
    if (j.phase === 'released' || j.phase === 'committed') return this.status(j);
    if (j.phase === 'staging') return this.status(j); // same-source stage replay fills missing inert rows
    const plan = await this.plan(j);
    await this.verify(plan, j, check); // recheck all identities before the first active write
    if (j.phase === 'staged') { await this.change(j, 'committing', check); j = (await this.journal())!; }
    for (const [target, record] of Object.entries(plan.records)) {
      await check();
      if (!(await this.context.storage.compareAndSet(target, null, record)).applied
        && canonicalBytes((await this.context.storage.get(target))?.value) !== canonicalBytes(record)) throw new Error('Active import target changed');
    }
    const missing = await this.verify(plan, j, check);
    if (!missing.length) { await this.change(j, 'committed', check); return this.status(await this.journal()); }
    return { ...this.status(j), needsOriginalOwnerBindings: missing };
  }
  bind(value: unknown, caller?: PluginActionContext) {
    const check = async () => {
      if (!caller || caller.ownerAuthProvenance !== 'strict') throw new Error('Strict authenticated original owner invocation required');
      if (this.stopped) throw new Error('Migration stopped'); await caller.assertCurrent();
    };
    return this.serialize(check, async () => {
      const input = value as { taskId?: string; expectedDigest?: string } | null, j = await this.journal();
      if (!j || j.phase !== 'committing' || j.planDigest !== input?.expectedDigest || caller!.userId !== j.userId)
        throw new Error('Exact committing import and owner required');
      const plan = await this.plan(j), row = plan.tasks.find(t => t.task.id === input.taskId && t.mode === 'typed');
      if (!row || row.task.ownerCatId !== caller!.catId || row.task.threadId !== caller!.threadId || isExpired(row.task, this.now()))
        throw new Error('Cannot bind another owner/thread or reactivate an expired wait');
      const key = ackKey(j.planDigest, row.task.id);
      let ack = await this.context.storage.get(key);
      const receipt = ack?.value as BindingAck | undefined;
      const current = await this.context.tasks.get({ id: row.task.id });
      const wait = importedWait(row.task);
      const projected = importedProjectionMatches(current, row.task, this.context.pluginInstanceId);
      const replayed = receipt?.state === 'intent' && projected;
      const host = await assertBinding(this.context, row.task, j.userId,
        replayed ? current!.updatedAt : receipt?.state === 'bound' ? receipt.updatedAt : row.task.updatedAt,
        replayed ? (wait.active ? 'doing' : wait.outcome ? 'done' : row.task.status) : receipt?.state === 'bound' ? receipt.status : row.task.status);
      if (receipt?.state === 'bound') {
        if (!projected) throw new Error('Bound Host wait changed; do not rearm');
      } else {
        if (host.pluginWait && !replayed) throw new Error('Host wait already exists; no takeover or rearm');
        if (!ack) {
          await check();
          if (!(await this.context.storage.compareAndSet(key, null, { state: 'intent', updatedAt: host.updatedAt, status: host.status })).applied)
            throw new Error('Binding admission raced');
          ack = await this.context.storage.get(key);
        }
        await check();
        const updated = replayed ? host : await this.context.tasks.update(row.task.id, { wait: { expectedGeneration: null, ...wait } }, { expectedThreadId: row.task.threadId });
        if (!updated) throw new Error('Host wait binding changed');
        await check();
        if (!ack || !(await this.context.storage.compareAndSet(key, ack.revision, { state: 'bound', updatedAt: updated.updatedAt, status: updated.status })).applied)
          throw new Error('Host binding acknowledgement raced');
      }
      return { data: { taskId: row.task.id, generation: wait.generation, bound: true, pollingStarted: false } };
    });
  }
  async stop() { this.stopped = true; await this.queue.catch(() => undefined); }
}
