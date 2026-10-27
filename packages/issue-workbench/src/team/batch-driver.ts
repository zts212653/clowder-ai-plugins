import type { AssignmentBatchDriver, AssignmentBatchItem } from './assignment-batch.js';
import { requireMember, type AssignmentOptions } from './group.js';
import type { DispatchRecord, Job, OwnerAssignment, TeamRecord } from './records.js';
import type { TeamAnalysis, TeamContext, TeamIssue, TeamProvider } from './types.js';
import { features, issueVersion } from './schema.js';

interface Planning {
  rows(): Promise<TeamRecord[]>;
  plan(issue: TeamIssue, records?: TeamRecord[]): Promise<{ options: AssignmentOptions; policyHash: string }>;
  effective(issue: TeamIssue): Promise<{ category?: string; analysis?: TeamAnalysis; stale: boolean }>;
}
interface Access {
  authorized(): Promise<void>;
  delivery(): Promise<'assignment' | 'invitation'>;
  repositories(): Promise<string[]>;
  activeSource(repo: string): Promise<void>;
  issue(repo: string, number: number): Promise<TeamIssue>;
  plan: Planning['plan'];
  snapshot(): Promise<Planning>;
  routable(thread: string, cat: string): Promise<void>;
  read(id: string): Promise<{ value: TeamRecord; revision: number } | undefined>;
  save(row: TeamRecord, expected: number | null): Promise<number>;
  deliver(job: Job, revision: number): Promise<unknown>;
  assign(job: DispatchRecord, revision: number, login: string, delivery: 'assignment' | 'invitation'): Promise<DispatchRecord>;
}
export function assignmentBatchDriver(context: TeamContext, provider: TeamProvider, signal: AbortSignal, access: Access): AssignmentBatchDriver {
  const delivery = () => access.delivery();
  const currentDelivery = async (expected: 'assignment' | 'invitation') => {
    if (await delivery() !== expected) throw new Error('派工方式已变化，请重新核对计划');
  };
  return {
    authorized: () => access.authorized(),
    delivery,
    async catalog() {
      const all: TeamIssue[] = [];
      for (const repo of await access.repositories()) {
        await access.activeSource(repo);
        const issues = await provider.openIssues(repo, signal);
        if (issues.some(i => i.repo !== repo || i.state !== 'open' || !i.id)) throw new Error('Invalid complete Open issue catalog');
        await access.activeSource(repo); all.push(...issues);
      }
      return all;
    },
    issue: async (repo, number) => { await access.activeSource(repo); return access.issue(repo, number); },
    async snapshotPreview() {
      const planning = await access.snapshot();
      return async (issue, reservations) => {
        await access.authorized();
        const effective = await planning.effective(issue), { options, policyHash } = await planning.plan(issue, reservations);
        const category = features(issue).length ? '随 Feature 处理' : effective.category ?? '待判断';
        const unresolved = (await planning.rows()).some(row => row.kind !== 'inbox' && row.issue.repo === issue.repo && row.issue.id === issue.id
          && row.assignment?.commentAttempted && !['assigned', 'invited'].includes(row.assignment.status));
        const status: AssignmentBatchItem['status'] = issue.state !== 'open' || issue.assignees.length ? 'retained'
          : effective.stale || unresolved ? 'blocked'
          : !effective.analysis && (category === '待判断' || !options.affectedSystems?.length && options.systemsSource !== 'human') ? 'needs-analysis'
          : options.blockedReason || !options.preferredLogin ? 'blocked' : 'ready';
        const reason = issue.state !== 'open' ? 'Issue 已关闭，本批保留'
          : issue.assignees.length ? '已有负责人，本批保留'
          : unresolved ? '存在发布结果待核对的历史派工，请先在派工记录中处理'
          : effective.stale ? '人工分析对应的原文已变化，请重新保存分析'
          : status === 'needs-analysis' ? '尚无当前有效分类，请补齐分类分析'
          : options.blockedReason ?? options.error;
        return { issue, sourceVersion: issueVersion(issue), policyHash, category, score: effective.analysis?.score ?? null, options, status, reason, ...(unresolved || effective.stale ? { lockedReason: reason } : {}) };
      };
    },
    async validateAccess(items, mode) {
      await currentDelivery(mode);
      const actor = await provider.identity(signal);
      if (mode === 'invitation') await requireMember(context, provider, signal, actor);
      for (const repo of new Set(items.map(i => i.issue.repo))) {
        await access.activeSource(repo);
        if (mode === 'invitation') continue;
        if (!await provider.canWrite(repo, actor, signal)) throw new Error(`${repo}：当前 GitHub 账号没有设置负责人权限，本批未派工`);
        for (const login of new Set(items.filter(i => i.issue.repo === repo).map(i => i.login))) {
          if (!login || !await provider.assignable(repo, login, signal)) throw new Error(`${repo}：@${login} 无法成为此仓库的负责人，本批未派工`);
        }
      }
    },
    async target(catId) {
      const threadId = await context.config.get('analysisThreadId');
      if (typeof threadId !== 'string' || !threadId) throw new Error('请先配置批量分析对话');
      await access.routable(threadId, catId); return threadId;
    },
    async analyze(batch, item) {
      if (!batch.catId || !batch.threadId || await context.config.get('analysisThreadId') !== batch.threadId) throw new Error('分析目标已变化，请停止后重新准备');
      await access.routable(batch.threadId, batch.catId);
      const issue = await access.issue(item.issue.repo, item.issue.number);
      if (issue.state !== 'open') return { done: true };
      if (issue.id !== item.issue.id || issueVersion(issue) !== item.sourceVersion) throw new Error('原文已变化，请刷新计划');
      const existing = await access.read(item.analysisJobId!);
      if (existing) {
        if (existing.value.kind !== 'analysis' || existing.value.assignmentBatchId !== batch.id) throw new Error('Batch analysis identity mismatch');
        if (existing.value.analysis) return { done: true };
        await access.deliver(existing.value, existing.revision);
        return { done: false, error: existing.value.error };
      }
      const job: Job = { kind: 'analysis', assignmentBatchId: batch.id, id: item.analysisJobId!, issue, sourceVersion: item.sourceVersion,
        features: features(issue), threadId: batch.threadId, catId: batch.catId, requester: 'system', requesterKind: 'owner', targetSelection: 'owner',
        ownerUserId: batch.ownerUserId, status: 'pending', createdAt: Date.now() };
      await access.deliver(job, await access.save(job, null));
      return { done: false, error: job.error };
    },
    async record(id) {
      const row = (await access.read(id))?.value;
      if (row?.kind === 'inbox') throw new Error('Unexpected inbox record');
      return row;
    },
    async dispatch(batch, item) {
      if (!batch.confirmation) throw new Error('批次尚未确认');
      const mode = batch.delivery ?? 'assignment';
      await currentDelivery(mode);
      const existing = await access.read(item.recordId!);
      if (existing) {
        const row = existing.value;
        if (row.kind !== 'assignment' || row.batch?.id !== batch.id || row.requestedLogin !== item.login) throw new Error('Batch dispatch identity mismatch');
        return access.assign(row, existing.revision, item.login, mode);
      }
      const issue = await access.issue(item.issue.repo, item.issue.number);
      const plan = await access.plan(issue);
      if (issue.id !== item.issue.id || issueVersion(issue) !== item.sourceVersion || issue.state !== 'open' || issue.assignees.length
        || plan.policyHash !== item.policyHash || plan.options.blockedReason || !plan.options.eligibleMembers?.includes(item.login)) {
        throw new Error(`${item.issue.repo}#${item.issue.number} 来源、负责人或策略已变化；本项未派工`);
      }
      const row: OwnerAssignment = { kind: 'assignment', id: item.recordId!, issue, sourceVersion: item.sourceVersion, features: features(issue),
        ownerUserId: batch.ownerUserId, ownerOperationId: batch.confirmation.operationId, requestedLogin: item.login, createdAt: Date.now(), category: item.category,
        batch: { id: batch.id, initiator: 'system', score: item.score, reason: item.options.recommendationReason ?? '主人在统一看板确认派工' },
        assignment: { status: 'pending', delivery: mode, login: item.login, rulesHash: item.policyHash,
          ...(item.login === item.options.preferredLogin && item.options.allocation ? { allocation: item.options.allocation } : {}) } };
      return access.assign(row, await access.save(row, null), item.login, mode);
    },
  };
}
