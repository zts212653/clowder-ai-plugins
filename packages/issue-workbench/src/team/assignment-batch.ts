import { z } from 'zod';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import type { AssignmentOptions } from './group.js';
import type { DispatchRecord, TeamRecord } from './records.js';
import type { TeamContext, TeamIssue } from './types.js';
import { hash, idInput, login, repository } from './schema.js';

const prefix = 'issue-workbench.assignment-batch.v1.';
const revisionInput = idInput.extend({ expectedRevision: z.number().int().positive() });
export interface AssignmentBatchItem {
  issue: TeamIssue; sourceVersion: string; policyHash: string; category: string; score: number | null;
  options: AssignmentOptions; included: boolean; login: string; manual?: boolean;
  status: 'ready' | 'needs-analysis' | 'blocked' | 'retained' | 'assigned' | 'invited' | 'failed';
  reason?: string; lockedReason?: string; analysisJobId?: string; recordId?: string;
}
export interface AssignmentBatch {
  id: string; requestId: string; ownerUserId: string; initiator: 'system'; createdAt: number;
  status: 'draft' | 'analyzing' | 'running' | 'partial' | 'completed' | 'cancelled';
  /** Older batches always meant assignment; a refresh explicitly adopts the configured mode. */
  delivery?: 'assignment' | 'invitation';
  items: AssignmentBatchItem[]; catId?: string; threadId?: string;
  confirmation?: { operationId: string; revision: number; at: number };
  error?: string;
}
export type AssignmentBatchView = AssignmentBatch & { revision: number };
export interface AssignmentBatchDriver {
  authorized(): Promise<void>;
  delivery(): Promise<'assignment' | 'invitation'>;
  catalog(): Promise<TeamIssue[]>;
  issue(repo: string, number: number): Promise<TeamIssue>;
  snapshotPreview(): Promise<(issue: TeamIssue, reservations: TeamRecord[]) => Promise<Omit<AssignmentBatchItem, 'included' | 'login'>>>;
  validateAccess(items: AssignmentBatchItem[], delivery: 'assignment' | 'invitation'): Promise<void>;
  target(catId: string): Promise<string>;
  analyze(batch: AssignmentBatch, item: AssignmentBatchItem): Promise<{ done: boolean; error?: string }>;
  dispatch(batch: AssignmentBatch, item: AssignmentBatchItem): Promise<DispatchRecord>;
  record(id: string): Promise<DispatchRecord | undefined>;
}
export const batchItemCompleted = (item: AssignmentBatchItem) => item.status === 'assigned' || item.status === 'invited';
// Share repeated roster/options inside the durable snapshot. A few hundred
// Open issues must not duplicate the seven-member roster into Host's 1 MiB value.
type StoredBatch = Omit<AssignmentBatch, 'items'> & { options: AssignmentOptions[];
  items: Array<Omit<AssignmentBatchItem, 'options'> & { options: number }> };
function encode(batch: AssignmentBatch): StoredBatch {
  const options: AssignmentOptions[] = [], keys: string[] = [];
  return { ...batch, options, items: batch.items.map(item => {
    const key = JSON.stringify(item.options); let index = keys.indexOf(key);
    if (index < 0) { index = keys.length; keys.push(key); options.push(item.options); }
    return { ...item, options: index };
  }) };
}
function decode(value: unknown): AssignmentBatch {
  // Early preview archives stored each row's full options. Keep those durable
  // drafts readable across upgrades; the next owner write normalizes them.
  if (!Object.hasOwn(value as object, 'options')) return structuredClone(value as AssignmentBatch);
  const { options, ...batch } = value as StoredBatch;
  return { ...batch, items: batch.items.map(item => {
    if (!options[item.options]) throw new Error('Invalid assignment batch snapshot');
    return { ...item, options: structuredClone(options[item.options]) };
  }) };
}
/** The batch owns the reviewed selection; individual dispatch records still own
 * external effects and deduplication. Only the existing Host schedule advances it. */
export class AssignmentBatches {
  constructor(private readonly context: TeamContext, private readonly driver: AssignmentBatchDriver) {}
  private async write(batch: AssignmentBatch, expected: number | null) {
    await this.driver.authorized();
    const saved = await this.context.storage.compareAndSet(prefix + batch.id, expected, encode(batch));
    if (!saved.applied || saved.revision === undefined) throw new Error('批次版本已变化，请刷新看板');
    return { ...batch, revision: saved.revision };
  }
  private async list() {
    return Object.entries(await this.context.storage.list()).filter(([key]) => key.startsWith(prefix))
      .map(([, e]) => ({ ...decode(e.value), revision: e.revision }))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  async holds(issue: TeamIssue) {
    return (await this.list()).some(b => b.items.some(i => i.issue.repo === issue.repo && i.issue.id === issue.id));
  }
  async get(input: unknown, owner: PluginOwnerOperationContext) {
    const args = z.object({ id: idInput.shape.id.optional() }).strict().parse(input);
    const batch = (await this.list()).find(b => args.id ? b.id === args.id : b.ownerUserId === owner.userId && b.status !== 'cancelled');
    if (!batch && args.id) throw new Error('Unknown assignment batch');
    if (batch && batch.ownerUserId !== owner.userId) throw new Error('Batch belongs to another owner');
    return batch ?? null;
  }
  private async owned(input: unknown, owner: PluginOwnerOperationContext) {
    const args = revisionInput.parse(input), view = await this.get({ id: args.id }, owner);
    if (!view || view.revision !== args.expectedRevision) throw new Error('批次版本已变化，请刷新看板');
    const { revision, ...batch } = view;
    return { batch, revision };
  }
  private async preview(issues: TeamIssue[], previous: AssignmentBatchItem[] = []) {
    const reservations: TeamRecord[] = [], items: AssignmentBatchItem[] = [];
    const previewIssue = await this.driver.snapshotPreview();
    for (const issue of issues) {
      const preview = await previewIssue(issue, reservations);
      // Do not duplicate issue bodies in the aggregate board journal.
      preview.issue = { ...preview.issue, body: '' };
      delete preview.options.acceptanceSuggestedFor;
      const old = previous.find(i => i.issue.repo === issue.repo && i.issue.id === issue.id);
      const item: AssignmentBatchItem = { ...preview, included: preview.status !== 'retained' && (old?.included ?? true),
        login: old?.manual ? old.login : preview.options.preferredLogin ?? '', ...(old?.manual ? { manual: true } : {}),
        ...(old?.analysisJobId ? { analysisJobId: old.analysisJobId } : {}) };
      if (item.status !== 'retained' && item.login && !item.options.eligibleMembers?.includes(item.login)) { item.status = 'blocked'; item.reason = '所选成员已不符合当前系统与分工，请重新选择'; }
      if (!item.login && item.status === 'ready') { item.status = 'blocked'; item.reason = item.options.error ?? '请选择可处理的成员'; }
      items.push(item);
      if (item.included && item.status === 'ready' && item.login === item.options.preferredLogin && item.options.allocation) {
        reservations.push({ kind: 'assignment', id: hash([issue.repo, issue.id]), issue, sourceVersion: item.sourceVersion, features: [],
          assignment: { status: 'assigned', login: item.login, allocation: { ...item.options.allocation, committed: true } } });
      }
    }
    return items;
  }
  async prepare(input: unknown, owner: PluginOwnerOperationContext) {
    const args = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }).strict().parse(input);
    const id = hash(['assignment-batch', this.context.pluginInstanceId, owner.userId, args.requestId]);
    const batches = await this.list();
    const existing = batches.find(b => b.id === id); if (existing) return existing;
    if (batches.some(b => ['draft', 'analyzing', 'running', 'partial'].includes(b.status))) throw new Error('请先处理或停止现有批次');
    const issues = await this.driver.catalog();
    const unique = [...new Map(issues.map(i => [i.repo + ':' + i.id, i])).values()]
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    const items = await this.preview(unique);
    return this.write({ id, requestId: args.requestId, ownerUserId: owner.userId, initiator: 'system', createdAt: Date.now(), status: 'draft', delivery: await this.driver.delivery(), items }, null);
  }
  private async currentIssues(batch: AssignmentBatch) {
    const catalog = new Map((await this.driver.catalog()).map(issue => [issue.repo + ':' + issue.id, issue]));
    const issues: TeamIssue[] = [];
    for (const item of batch.items) {
      // Only rows absent from the complete Open catalog need an individual
      // lookup, to distinguish closure/deletion/replacement from a stale page.
      issues.push(catalog.get(item.issue.repo + ':' + item.issue.id) ?? await this.driver.issue(item.issue.repo, item.issue.number));
    }
    return issues;
  }
  async refresh(input: unknown, owner: PluginOwnerOperationContext) {
    const { batch, revision } = await this.owned(input, owner);
    if (batch.status !== 'draft') throw new Error('只有待确认批次可以刷新计划');
    batch.items = await this.preview(await this.currentIssues(batch), batch.items);
    batch.delivery = await this.driver.delivery();
    delete batch.error; return this.write(batch, revision);
  }
  async edit(input: unknown, owner: PluginOwnerOperationContext) {
    const args = revisionInput.extend({ repo: repository, issueId: z.string().min(1), login: z.union([login, z.literal('')]), included: z.boolean() }).strict().parse(input);
    const { batch, revision } = await this.owned({ id: args.id, expectedRevision: args.expectedRevision }, owner);
    if (batch.status !== 'draft') throw new Error('批次已经确认或正在分析，不能修改人选');
    const item = batch.items.find(i => i.issue.repo === args.repo && i.issue.id === args.issueId);
    if (!item || item.status === 'retained') throw new Error('已有负责人或来源已关闭，本批保持原状');
    if (args.login && !item.options.eligibleMembers?.includes(args.login)) throw new Error('成员不符合当前系统与分工');
    const changed = item.login !== args.login;
    item.login = args.login; item.included = args.included;
    if (changed) item.manual = true;
    if (!item.lockedReason && !item.options.blockedReason && item.category !== '待判断') {
      item.status = item.login ? 'ready' : 'blocked'; item.reason = item.login ? undefined : '请选择可处理的成员';
    }
    return this.write(batch, revision);
  }
  async analyze(input: unknown, owner: PluginOwnerOperationContext) {
    const args = revisionInput.extend({ catId: z.string().min(1).max(128) }).strict().parse(input);
    const { batch, revision } = await this.owned({ id: args.id, expectedRevision: args.expectedRevision }, owner);
    if (batch.status !== 'draft') throw new Error('只能分析待确认批次');
    batch.threadId = await this.driver.target(args.catId); batch.catId = args.catId;
    batch.status = 'analyzing'; delete batch.error;
    return this.write(batch, revision);
  }
  private async validate(batch: AssignmentBatch) {
    const selected = batch.items.filter(i => i.included && !batchItemCompleted(i));
    if (!selected.length) throw new Error('没有待派工条目');
    await this.driver.validateAccess(selected, batch.delivery ?? 'assignment');
    const catalog = await this.driver.catalog(), previewIssue = await this.driver.snapshotPreview();
    for (const item of selected) {
      if (!item.login || !['ready', 'failed'].includes(item.status)) throw new Error('请先处理待分析/待判断条目，或取消本次参与');
      const current = catalog.find(i => i.repo === item.issue.repo && i.id === item.issue.id);
      if (!current) throw new Error(`${item.issue.repo}#${item.issue.number} 来源已关闭或不可读，请刷新计划`);
      const plan = await previewIssue(current, []);
      const own = item.recordId ? await this.driver.record(item.recordId) : undefined;
      const ownClaim = own?.assignment?.login === item.login && current.assignees.every(login => login === item.login);
      if (current.id !== item.issue.id || current.state !== 'open' || plan.sourceVersion !== item.sourceVersion || plan.policyHash !== item.policyHash
        || plan.lockedReason && !own || plan.options.blockedReason || !plan.options.eligibleMembers?.includes(item.login) || current.assignees.length && !ownClaim) {
        throw new Error(`${item.issue.repo}#${item.issue.number} 来源、负责人或成员策略已变化，请刷新计划`);
      }
    }
  }
  async confirm(input: unknown, owner: PluginOwnerOperationContext, retry = false) {
    const args = revisionInput.strict().parse(input);
    const existing = await this.get({ id: args.id }, owner);
    // Lost HTTP response: the exact previously confirmed revision is read-only.
    if (existing?.confirmation?.revision === args.expectedRevision) return existing;
    const { batch, revision } = await this.owned(input, owner);
    if (batch.status !== (retry ? 'partial' : 'draft')) throw new Error('批次状态不能执行，请刷新');
    await this.validate(batch);
    batch.status = 'running'; batch.confirmation = { operationId: owner.requestId, revision, at: Date.now() }; delete batch.error;
    return this.write(batch, revision);
  }
  async cancel(input: unknown, owner: PluginOwnerOperationContext) {
    const { batch, revision } = await this.owned(input, owner);
    batch.status = 'cancelled'; return this.write(batch, revision);
  }
  private async pump(view: AssignmentBatchView) {
    let { revision, ...batch } = view;
    try {
      if (batch.status === 'analyzing') {
        for (const item of batch.items) {
          if (!item.included || item.status !== 'needs-analysis') continue;
          item.analysisJobId ??= hash(['assignment-batch-analysis', batch.id, item.issue.repo, item.issue.id]);
          revision = (await this.write(batch, revision)).revision;
          const result = await this.driver.analyze(batch, item);
          if (!result.done) { batch.error = result.error; return this.write(batch, revision); }
          // A completed, still uncertain analysis stays visibly blocked and does
          // not request the same model again on every scheduled tick.
          item.status = 'blocked';
        }
        batch.items = await this.preview(await this.currentIssues(batch), batch.items);
        batch.status = 'draft'; delete batch.error;
      } else if (batch.status === 'running') {
        if (!batch.confirmation) throw new Error('缺少批次确认，不能执行');
        let remaining = 10;
        for (const item of batch.items) {
          if (!item.included || batchItemCompleted(item)) continue;
          if (!remaining--) break;
          item.recordId ??= hash(['assignment-batch-dispatch', batch.id, item.issue.repo, item.issue.id]);
          revision = (await this.write(batch, revision)).revision;
          const row = await this.driver.dispatch(batch, item);
          item.status = row.assignment?.status === 'assigned' || row.assignment?.status === 'invited' ? row.assignment.status : 'failed';
          item.reason = row.assignment?.reason;
          if (item.status === 'failed') { batch.status = 'partial'; break; }
        }
        if (batch.items.every(i => !i.included || batchItemCompleted(i))) batch.status = 'completed';
      }
    } catch (error) {
      await this.driver.authorized(); batch.error = error instanceof Error ? error.message.slice(0, 300) : '批次处理失败';
      batch.status = batch.status === 'running' ? 'partial' : 'draft';
    }
    return this.write(batch, revision);
  }
  async recover() {
    for (const batch of await this.list()) if (batch.status === 'analyzing' || batch.status === 'running') await this.pump(batch);
  }
}
