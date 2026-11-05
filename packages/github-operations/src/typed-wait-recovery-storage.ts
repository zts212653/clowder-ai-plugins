import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { assertWaitStorage, decodeWaitTask, publishWaitRecord, WAIT_PREFIX, waitKey, type WaitRecordV1 } from './typed-wait-record.js';
import { waitIndex, waitRecoveryScope, assertWaitRecovery, reconcileWaitRecovery, type GitHubWaitRecoveryFacts, type GitHubRecoveryNotice } from './typed-wait-recovery.js';
import { parkMalformedWait } from './typed-wait-invalid-record.js';
import { storageEntries } from './storage-pages.js';
const CENSUS = 'github.typed-wait.recovery-census.v1';
export interface GitHubWaitRecoveryCandidate { task: TaskItem; recovery: GitHubWaitRecoveryFacts }

/** Original wait records own recovery; the Host only publishes their single derived projection atomically. */
export class GitHubWaitRecoveryStorage {
  private preparing?: Promise<void>;
  constructor(private readonly storage: PluginStorageHost, private readonly now: () => number, private readonly intervalMs: number) {}
  initialize(rebuild = false): Promise<void> {
    if (this.preparing) return this.preparing;
    const operation = this.prepare(rebuild); this.preparing = operation;
    void operation.finally(() => { if (this.preparing === operation) this.preparing = undefined; }).catch(() => undefined);
    return operation;
  }
  private async prepare(rebuild: boolean): Promise<void> {
    assertWaitStorage(this.storage);
    const previous = await this.storage.get(CENSUS);
    let progressRevision = previous?.revision ?? null;
    let progress = previous?.value as { v: number; status: 'backfill' | 'building' | 'ready'; cursor: string } | undefined;
    if (progress?.status === 'ready' && !rebuild) return;
    progress ??= { v: 1, status: 'backfill', cursor: '0' };
    if (rebuild) {
      progress = { ...progress, status: 'building' };
      const started = await this.storage.compareAndSet(CENSUS, progressRevision, progress);
      if (!started.applied) throw new Error('Wait census changed before explicit rebuild; retry');
      progressRevision = started.revision!;
    }
    if (!this.storage.scan) throw new Error('Explicit wait recovery census pagination is unavailable');
    while (progress.status === 'backfill') {
      const page = await this.storage.scan({ prefix: WAIT_PREFIX, cursor: progress.cursor, count: 50 });
      for (const [name, entry] of Object.entries(page.entries)) {
        if (!name.startsWith(WAIT_PREFIX)) continue;
        let record: WaitRecordV1, task: TaskItem;
        try {
          record = entry.value as WaitRecordV1;
          task = decodeWaitTask(record);
          if (name !== waitKey(task.id)) throw new Error('GitHub wait recovery identity mismatch');
          if (record.recovery !== undefined) assertWaitRecovery(record.recovery);
        } catch {
          const raw = entry.value as Partial<WaitRecordV1> | null;
          const known = raw?.recovery?.index;
          const index = known === 'github-pr-waits' || known === 'github-issue-waits' ? known :
            raw?.task?.kind === 'issue_tracking' ? waitIndex('issue_tracking') :
            raw?.task?.kind === 'pr_tracking' ? waitIndex('pr_tracking') : 'github-invalid-waits';
          await parkMalformedWait(this.storage, name, entry, index);
          continue;
        }
        if (!(await publishWaitRecord(this.storage, name, entry.revision, record, this.now(), this.intervalMs)).applied)
          throw new Error('Wait changed during census; retry the uncommitted page');
      }
      progress = { v: 1, status: page.cursor === '0' ? 'building' : 'backfill', cursor: page.cursor };
      const saved = await this.storage.compareAndSet(CENSUS, progressRevision, progress);
      if (!saved.applied)
        throw new Error('Wait recovery census changed concurrently; resume its persisted cursor');
      progressRevision = saved.revision!;
    }
    await this.storage.rebuildIndex(waitIndex('pr_tracking'));
    await this.storage.rebuildIndex(waitIndex('issue_tracking'));
    if (!(await this.storage.compareAndSet(CENSUS, progressRevision, { ...progress, status: 'ready' })).applied)
      throw new Error('Wait recovery readiness changed concurrently; retry preparation');
  }
  async listDue(kind: TaskItem['kind'], now: number, limit = 20): Promise<GitHubWaitRecoveryCandidate[]> {
    await this.initialize(); assertWaitStorage(this.storage);
    const page = await this.storage.readDue({ index: waitIndex(kind), before: now, limit });
    if (page.status !== 'ready') throw new Error('GitHub wait index is not_ready; original waits retained for explicit rebuild');
    const candidates: GitHubWaitRecoveryCandidate[] = [];
    for (const [name, entry] of Object.entries(page.entries)) {
      try {
        const task = decodeWaitTask(entry.value), recovery = (entry.value as WaitRecordV1).recovery;
        assertWaitRecovery(recovery);
        if (name !== waitKey(task.id) || task.kind !== kind || recovery.index !== waitIndex(kind) || recovery.scope !== waitRecoveryScope(task))
          throw new Error('GitHub due wait identity mismatch');
        candidates.push({ task, recovery });
      } catch {
        await parkMalformedWait(this.storage, name, entry, waitIndex(kind));
      }
    }
    return candidates;
  }
  async facts(id: string): Promise<GitHubWaitRecoveryFacts | null> {
    const entry = await this.storage.get(waitKey(id));
    return entry ? structuredClone((entry.value as WaitRecordV1).recovery ?? null) : null;
  }
  /** Explicit owner inspection includes retained invalid rows without running a census or a writer. */
  async diagnostics() {
    return (await storageEntries(this.storage, WAIT_PREFIX)).map(([sourceKey, entry]) => {
      const row = entry.value as Partial<WaitRecordV1> | null;
      return { sourceKey, sourceRevision: entry.revision, taskId: row?.task?.id, subjectKey: row?.task?.subjectKey,
        recovery: structuredClone(row?.recovery ?? { disposition: 'unknown', reasonCode: 'recovery_not_prepared' }) };
    });
  }
  async finish(candidate: GitHubWaitRecoveryCandidate, failed: boolean, nextPollAt: number): Promise<void> {
    await this.mutate(candidate.task.id, (record) => {
      const facts = record.recovery;
      if (!facts || facts.scope !== candidate.recovery.scope || facts.revision !== candidate.recovery.revision) return false;
      facts.revision++; facts.nextPollAt = nextPollAt;
      if (failed) facts.failures++;
      if (facts.failures >= 5) {
        facts.disposition = 'needs_attention'; facts.reasonCode = 'github_observation_failed';
        const key = `github-wait-recovery:${facts.scope}`;
        if (record.task.userId && record.task.threadId && facts.lastNoticeKey !== key)
          facts.notices[key] ??= { key, scope: facts.scope, userId: record.task.userId, threadId: record.task.threadId,
            taskId: record.task.id, failures: 0, nextAt: this.now(), state: 'pending' };
      }
      return true;
    });
  }
  async finishNotice(id: string, selected: GitHubRecoveryNotice, state: GitHubRecoveryNotice['state']): Promise<void> {
    const archive = `github.wait-notice.${createHash('sha256').update(selected.key).digest('hex')}`;
    await this.mutate(id, (record) => {
      const facts = record.recovery, notice = facts?.notices[selected.key];
      if (!facts || !notice || notice.state !== 'pending' || notice.scope !== selected.scope || notice.failures !== selected.failures) return false;
      notice.state = state;
      if (state === 'pending') { notice.failures++; notice.nextAt = this.now() + this.intervalMs; if (notice.failures >= 5) notice.state = 'needs_attention'; }
      return true;
    });
    const facts = await this.facts(id), notice = facts?.notices[selected.key];
    if (!notice || notice.state === 'pending') return;
    const old = await this.storage.get(archive);
    if (!old && !(await this.storage.compareAndSet(archive, null, notice)).applied) throw new Error('Notice archive raced; retain original intent');
    if (old && JSON.stringify(old.value) !== JSON.stringify(notice)) throw new Error('Notice archive identity conflict');
    await this.mutate(id, record => {
      const current = record.recovery?.notices[selected.key];
      if (!current || JSON.stringify(current) !== JSON.stringify(notice)) return false;
      if (record.recovery!.scope === current.scope) record.recovery!.lastNoticeKey = current.key;
      delete record.recovery!.notices[current.key]; return true;
    });
  }
  private async mutate(id: string, change: (record: WaitRecordV1) => boolean): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.storage.get(waitKey(id)); if (!entry) return;
      const task = decodeWaitTask(entry.value); if (task.id !== id) throw new Error('GitHub wait key mismatch');
      const record = structuredClone(entry.value) as WaitRecordV1;
      const recovery = reconcileWaitRecovery(task, record.recovery, this.now(), this.intervalMs);
      const next = { ...record, recovery };
      if (!change(next)) return;
      if ((await publishWaitRecord(this.storage, waitKey(id), entry.revision, next, this.now(), this.intervalMs)).applied) return;
    }
    throw new Error('GitHub wait recovery CAS raced; retain original responsibility');
  }
}
