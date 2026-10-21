import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import type { GitHubTrackingProvider, GitHubTarget } from './tracking-runtime.js';
import { assertBinding } from './migration-plan.js';
import { migrationKey } from './migration-source.js';
import { buildIssueCommentContent } from './business/infrastructure/email/IssueCommentRouter.js';
import { createGitHubFeedbackFilter } from './business/infrastructure/email/github-feedback-filter.js';
import { createSetupNoiseFilter } from './business/infrastructure/email/setup-noise-filter.js';

interface RecordV1 {
  schemaVersion: 1; task: TaskItem; sourceUpdatedAt: number;
  outbox?: { key: string; content: string; cursor: number; terminal: boolean };
}
/** Continuous legacy issue observation is not a new typed wait: no generation,
 * live baseline or registration receipt is manufactured. */
export class MigratedIssueRuntime {
  private readonly stopController = new AbortController();
  private pending?: Promise<void>;
  constructor(private readonly context: FeatureContext, private readonly provider: GitHubTrackingProvider,
    private readonly selfLogin: () => string | undefined, private readonly now = Date.now) {}
  async list(): Promise<readonly TaskItem[]> {
    return Object.entries(await this.context.storage.list()).filter(([key]) => key.startsWith('github.migrated-issue.v1.'))
      .map(([, entry]) => (entry.value as RecordV1).task);
  }
  poll() {
    if (this.pending) return this.pending;
    const run = this.collect(); this.pending = run;
    void run.finally(() => { if (this.pending === run) this.pending = undefined; }).catch(() => {});
    return run;
  }
  private async collect() {
    for (const [key] of Object.entries(await this.context.storage.list()).filter(([k]) => k.startsWith('github.migrated-issue.v1.'))) {
      this.stopController.signal.throwIfAborted();
      try { await this.one(key); }
      catch { this.context.log('warn', 'Migrated issue observation retained for retry'); }
    }
  }
  private async one(key: string) {
    const signal = AbortSignal.any([this.stopController.signal, AbortSignal.timeout(30_000)]);
    const check = () => signal.throwIfAborted();
    let entry = await this.context.storage.get(key);
    if (!entry) return;
    let row = entry.value as RecordV1;
    if (row.schemaVersion !== 1 || row.task.kind !== 'issue_tracking' || row.task.automationState?.await
      || !row.task.userId || !Number.isFinite(row.sourceUpdatedAt)) throw new Error('Invalid migrated issue record');
    if (row.task.status === 'done') return;
    const authorize = async () => { check(); await assertBinding(this.context, row.task, row.task.userId!, row.sourceUpdatedAt); check(); };
    await authorize();
    if (!row.outbox) {
      const match = /^issue:([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d*)$/.exec(row.task.subjectKey ?? '');
      if (!match) throw new Error('Invalid migrated issue subject');
      const issue = row.task.automationState!.issue!;
      const collected = issue.lastCommentCursor!, delivered = issue.lastDeliveredCursor ?? collected;
      const target: GitHubTarget = { kind: 'issue', repoFullName: match[1]!, number: Number(match[2]), threadId: row.task.threadId, catId: row.task.ownerCatId! };
      const snapshot = await this.provider.read(target, signal, { inline: 0, conversation: collected });
      await authorize();
      if (snapshot.commentsComplete !== true) throw new Error('Incomplete legacy issue comment page');
      const comments = snapshot.comments.filter(c => c.commentType === 'conversation' && c.id > delivered).sort((a,b) => a.id - b.id);
      const cursor = Math.max(collected, ...comments.map(c => c.id));
      const filter = createGitHubFeedbackFilter({ getSelfGitHubLogin: this.selfLogin });
      const configuredNoise = await this.context.config.get('setupNoiseBotLogins');
      if (configuredNoise !== undefined && typeof configuredNoise !== 'string') throw new Error('Invalid setup noise configuration');
      const noise = createSetupNoiseFilter(configuredNoise?.split(/[\s,]+/).filter(Boolean) ?? []);
      const visible = comments.filter(c => !filter.shouldSkipComment(c) && !noise(c));
      const terminal = snapshot.state !== 'open';
      const content = visible.length ? buildIssueCommentContent({ repoFullName: target.repoFullName, issueNumber: target.number,
        newComments: visible.map(c => ({ ...c, createdAt: c.createdAt ?? new Date(0).toISOString() })) })
        : terminal ? `GitHub issue closed: ${row.task.subjectKey}` : undefined;
      const next: RecordV1 = { ...row, task: { ...row.task, updatedAt: Math.max(this.now(), row.task.updatedAt + 1), automationState: {
        issue: { ...issue, lastCommentCursor: cursor, ...(content ? {} : { lastDeliveredCursor: cursor }), issueState: terminal ? 'closed' : 'open' } },
        ...(terminal && !content ? { status: 'done' } : {}) },
        ...(content ? { outbox: { key: `github:migrated-issue:${migrationKey(row.task.id)}:${cursor}:${snapshot.state}`, content, cursor, terminal } } : {}) };
      await authorize();
      if (!(await this.context.storage.compareAndSet(key, entry.revision, next)).applied) throw new Error('Legacy issue changed during observation');
      entry = await this.context.storage.get(key); if (!entry) throw new Error('Legacy issue disappeared'); row = entry.value as RecordV1;
    }
    if (!row.outbox) return;
    await authorize();
    const outbox = row.outbox;
    await this.context.messaging.send(row.task.threadId, { identity: 'github-notification', idempotencyKey: outbox.key,
      wake: { catId: row.task.ownerCatId! }, meta: { subjectKey: row.task.subjectKey, originalTaskId: row.task.id },
      payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: outbox.key, kind: 'text', payload: { text: outbox.content } }] } });
    await authorize();
    const { outbox: _sent, ...settled } = row;
    if (!(await this.context.storage.compareAndSet(key, entry.revision, { ...settled, task: { ...row.task,
      ...(outbox.terminal ? { status: 'done' } : {}), automationState: { issue: { ...row.task.automationState!.issue,
        lastDeliveredCursor: outbox.cursor, lastNotifiedAt: this.now() } } } })).applied) throw new Error('Delivery acknowledgement changed; retry the same outbox key');
  }
  async stop() { this.stopController.abort(); await this.pending?.catch(() => {}); }
}
