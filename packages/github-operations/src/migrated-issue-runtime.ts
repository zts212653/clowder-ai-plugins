import { storageEntries } from './storage-pages.js';
import type { FeatureContext, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { MIGRATED_ISSUES, MIGRATED_ISSUE_INDEX, migratedIssueKey, decodeMigratedIssue, materializeMigratedIssue,
  migratedIssueIndexOwner, type MigratedIssueRecord as RecordV1 } from './migrated-issue-record.js';
import { GitHubRateLimitError } from './business/infrastructure/github/request-budget.js';
import { gitHubPollBudget, gitHubAdmissionCanContinue, gitHubObjectAdmission } from './business/infrastructure/github/admission-budget.js';
import { advanceRecoveryNotice, sendRecoveryOwnerNotice } from './recovery-owner-notice.js';
import type { TaskItem } from './business/model/index.js';
import type { GitHubTrackingProvider, GitHubTarget } from './tracking-runtime.js';
import { assertBinding } from './migration-plan.js';
import { migrationKey } from './migration-source.js';
import { buildIssueCommentContent } from './business/infrastructure/email/IssueCommentRouter.js';
import { createGitHubFeedbackFilter } from './business/infrastructure/email/github-feedback-filter.js';
import { createSetupNoiseFilter } from './business/infrastructure/email/setup-noise-filter.js';

class MigratedIssueChanged extends Error {}
/** Continuous legacy issue observation is not a new typed wait: no generation,
 * live baseline or registration receipt is manufactured. */
export class MigratedIssueRuntime {
  private readonly stopController = new AbortController();
  private pending?: Promise<void>;
  private readonly indexed: ReturnType<typeof migratedIssueIndexOwner>;
  constructor(private readonly context: FeatureContext, private readonly provider: GitHubTrackingProvider,
    private readonly selfLogin: () => string | undefined, private readonly now = Date.now,
    private readonly intervalMs = 60_000) { this.indexed = migratedIssueIndexOwner(context.storage); }
  initialize(rebuild = false) { return this.indexed.initialize(rebuild); }
  async list(): Promise<readonly TaskItem[]> {
    return (await storageEntries(this.context.storage, MIGRATED_ISSUES, { signal: this.stopController.signal }))
      .map(([, entry]) => (entry.value as RecordV1).task);
  }
  async recoveryDiagnostics() {
    return (await storageEntries(this.context.storage, MIGRATED_ISSUES)).map(([sourceKey, entry]) => {
      const row = entry.value as Partial<RecordV1>;
      return { sourceKey, taskId: row.task?.id, subjectKey: row.task?.subjectKey,
        recovery: row.recovery ?? { disposition: 'needs_attention', reasonCode: 'invalid_source' }, noticeState: row.notice?.state };
    });
  }
  poll() {
    if (this.pending) return this.pending;
    const run = this.collect(); this.pending = run;
    void run.finally(() => { if (this.pending === run) this.pending = undefined; }).catch(() => {});
    return run;
  }
  private async collect() {
    const budget = gitHubPollBudget(this.stopController.signal, { now: this.now, pollBudgetMs: 50_000, objectTimeoutMs: 40_000 });
    const due = await this.indexed.due(MIGRATED_ISSUE_INDEX, this.now());
    for (const [key, source] of Object.entries(due)) {
      this.stopController.signal.throwIfAborted();
      if (!gitHubAdmissionCanContinue(budget)) break;
      const admission = gitHubObjectAdmission(budget), signal = admission.signal!;
      const attempt = { entry: source };
      try {
        const row = decodeMigratedIssue(attempt.entry.value);
        if (row.notice) {
          const notice = await advanceRecoveryNotice(this.context.storage, row.notice, sendRecoveryOwnerNotice(this.context), this.now());
          const next = { ...row, notice, recovery: { ...row.recovery!,
            ...(!notice && row.recovery!.scope === row.notice.scope ? { lastNoticeKey: row.notice.key } : {}) } };
          const result = await this.indexed.publish(key, attempt.entry.revision, next);
          if (!result.applied) continue;
          attempt.entry = { revision: result.revision!, value: materializeMigratedIssue(next) };
        }
        if (row.recovery?.disposition || row.recovery!.nextAt > this.now()) continue;
        await this.one(key, attempt, signal);
        signal.throwIfAborted();
        await this.finish(key, attempt.entry, false);
      } catch (error) {
        this.stopController.signal.throwIfAborted();
        if (error instanceof MigratedIssueChanged) continue;
        if (signal.aborted && admission.limitedByPoll) break;
        const limited = error instanceof GitHubRateLimitError;
        await this.finish(key, attempt.entry, !limited, limited ? error.retryAt : 0);
        this.context.log(limited ? 'info' : 'warn', limited ? 'Migrated issue quota deferred' : 'Migrated issue observation retained for finite recovery');
        if (limited) break;
      }
    }
  }
  private async finish(key: string, source: PluginStorageEntry, failed: boolean, notBefore = 0) {
    const current = await this.context.storage.get(key); if (!current || current.revision !== source.revision) return;
    const row = decodeMigratedIssue(current.value), recovery = row.recovery!;
    const failures = recovery.failures + (failed ? 1 : 0);
    await this.indexed.publish(key, current.revision, { ...row, recovery: { ...recovery, revision: recovery.revision + 1,
      failures, nextAt: Math.max(this.now() + this.intervalMs, notBefore), ...(failures >= 5 ? { disposition: 'needs_attention', reasonCode: 'migrated_issue_observation_failed' } : {}) } });
  }
  private async one(key: string, attempt: { entry: PluginStorageEntry }, signal: AbortSignal) {
    const check = () => signal.throwIfAborted();
    let entry = attempt.entry;
    let row = decodeMigratedIssue(entry.value);
    if (key !== migratedIssueKey(row.task.id)) throw new Error('Migrated issue key identity mismatch');
    if (row.schemaVersion !== 1 || row.task.kind !== 'issue_tracking' || row.task.automationState?.await
      || !row.task.userId || !Number.isFinite(row.sourceUpdatedAt)) throw new Error('Invalid migrated issue record');
    if (row.task.status === 'done') {
      if (row.outbox) throw new Error('Terminal migrated issue retains an unresolved delivery; no wake authority');
      return;
    }
    const publish = async (next: RecordV1) => {
      check();
      const result = await this.indexed.publish(key, entry.revision, next);
      if (!result.applied) throw new MigratedIssueChanged('Migrated issue changed concurrently');
      entry = { revision: result.revision!, value: materializeMigratedIssue(next) };
      attempt.entry = entry; row = decodeMigratedIssue(entry.value);
    };
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
      await publish(next);
    }
    if (!row.outbox) return;
    await authorize();
    const outbox = row.outbox;
    await this.context.messaging.send(row.task.threadId, { identity: 'github-notification', idempotencyKey: outbox.key,
      wake: { catId: row.task.ownerCatId! }, meta: { subjectKey: row.task.subjectKey, originalTaskId: row.task.id },
      payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: outbox.key, kind: 'text', payload: { text: outbox.content } }] } });
    await authorize();
    const { outbox: _sent, ...settled } = row;
    await publish({ ...settled, task: { ...row.task,
      ...(outbox.terminal ? { status: 'done' } : {}), automationState: { issue: { ...row.task.automationState!.issue,
        lastDeliveredCursor: outbox.cursor, lastNotifiedAt: this.now() } } } });
  }
  async stop() { this.stopController.abort(); await this.pending?.catch(() => {}); }
}
