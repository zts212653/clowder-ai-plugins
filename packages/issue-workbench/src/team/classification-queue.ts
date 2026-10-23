import { z } from 'zod';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { hash, idInput, repository } from './schema.js';
import type { Job } from './records.js';
import type { TeamContext, TeamIssue } from './types.js';

const prefix = 'issue-workbench.classification.v1.';
const request = z.object({ repo: repository, catId: z.string().trim().min(1).max(128),
  requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }).strict();
export interface ClassificationQueue {
  id: string; repo: string; catId: string; threadId: string; requestId: string;
  ownerUserId?: string; ownerOperationId?: string; createdAt: number;
  origin?: 'integration'; scope?: 'all';
  status: 'paused' | 'running' | 'completed' | 'stopped';
  items: Array<{ number: number; issueId: string; status: 'pending' | 'waiting' | 'analyzed' | 'skipped'; jobId?: string; reason?: string }>;
  error?: string;
}
export type ClassificationQueueView = ClassificationQueue & { revision: number };
interface Driver {
  authorized(): Promise<void>;
  allowed(repo: string): Promise<void>;
  target(threadId: string, catId: string): Promise<void>;
  catalog(repo: string, scope?: 'all'): Promise<TeamIssue[]>;
  job(queue: ClassificationQueue, item: ClassificationQueue['items'][number]): Promise<Job | null>;
}

/** Persistent, explicitly started batches. The Host's existing schedule drives
 * one outstanding analysis per batch; no private timer or second Task authority. */
export class ClassificationQueues {
  constructor(private readonly context: TeamContext, private readonly driver: Driver) {}
  private async write(queue: ClassificationQueue, expected: number | null) {
    await this.driver.authorized();
    const saved = await this.context.storage.compareAndSet(prefix + queue.id, expected, queue);
    if (!saved.applied || saved.revision === undefined) throw new Error('Classification queue changed; refresh before retrying');
    return { ...queue, revision: saved.revision };
  }
  private async read(id: string): Promise<ClassificationQueueView> {
    const entry = await this.context.storage.get(prefix + id);
    const queue = entry?.value as ClassificationQueue | undefined;
    if (!queue || queue.id !== id) throw new Error('Unknown classification queue');
    await this.driver.allowed(queue.repo);
    return { ...queue, revision: entry!.revision };
  }
  async list(): Promise<ClassificationQueueView[]> {
    const result: ClassificationQueueView[] = [];
    for (const [key, entry] of Object.entries(await this.context.storage.list())) {
      if (!key.startsWith(prefix)) continue;
      const queue = entry.value as ClassificationQueue;
      try { await this.driver.allowed(queue.repo); }
      catch { await this.driver.authorized(); continue; }
      result.push({ ...queue, revision: entry.revision });
    }
    return result.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  async permits(job: Job) {
    if (!job.classificationQueueId) return true;
    const queue = await this.read(job.classificationQueueId);
    return ['running', 'completed'].includes(queue.status) && queue.catId === job.catId && queue.threadId === job.threadId
      && (queue.origin !== 'integration' || await this.context.config.get('initialClassification') === true);
  }
  async integrate(repo: string) {
    if (await this.context.config.get('initialClassification') !== true) return;
    await this.driver.allowed(repo);
    const id = hash(['initial-classification', this.context.pluginInstanceId, repo]);
    // Presence, including stopped/completed, means this integration was handled.
    // No config refresh or restart creates a second initial batch.
    if (await this.context.storage.get(prefix + id)) return;
    if ((await this.list()).some(queue => queue.repo === repo && ['paused', 'running'].includes(queue.status))) return;
    const catId = await this.context.config.get('analysisCatId'), threadId = await this.context.config.get('analysisThreadId');
    if (typeof catId !== 'string' || !catId || typeof threadId !== 'string' || !threadId) throw new Error('首次自动分类等待配置分析猫和对话');
    await this.driver.target(threadId, catId);
    const issues = await this.driver.catalog(repo, 'all');
    if (issues.some(issue => issue.repo !== repo || !issue.id)) throw new Error('Invalid complete issue catalog');
    await this.driver.allowed(repo);
    if (await this.context.config.get('initialClassification') !== true || await this.context.config.get('analysisCatId') !== catId
      || await this.context.config.get('analysisThreadId') !== threadId) throw new Error('Initial classification settings changed');
    const items = [...new Map(issues.map(issue => [issue.id, issue])).values()].sort((a, b) => a.number - b.number)
      .map(issue => ({ number: issue.number, issueId: issue.id, status: 'pending' as const }));
    await this.write({ id, repo, catId, threadId, requestId: 'initial', origin: 'integration', scope: 'all',
      createdAt: Date.now(), status: items.length ? 'running' : 'completed', items }, null);
  }
  async plan(input: unknown, owner: PluginOwnerOperationContext) {
    const args = request.parse(input);
    await this.driver.allowed(args.repo);
    const id = hash(['classification-queue', owner.userId, args.repo, args.requestId]);
    const existing = await this.context.storage.get(prefix + id);
    if (existing) {
      const queue = await this.read(id);
      if (queue.catId !== args.catId || queue.ownerUserId !== owner.userId) throw new Error('Queue target changed; use a new request');
      return queue;
    }
    if ((await this.list()).some(queue => queue.repo === args.repo && ['paused', 'running'].includes(queue.status))) {
      throw new Error('此仓库已有研判队列，请继续或停止原队列');
    }
    const threadId = await this.context.config.get('analysisThreadId');
    if (typeof threadId !== 'string' || !threadId) throw new Error('Select an analysis thread in plugin Settings');
    await this.driver.target(threadId, args.catId);
    const issues = await this.driver.catalog(args.repo);
    if (issues.some(issue => issue.repo !== args.repo || issue.state !== 'open' || !issue.id)) throw new Error('Invalid complete Open issue catalog');
    await this.driver.allowed(args.repo);
    const items = [...new Map(issues.map(issue => [issue.id, issue])).values()]
      .sort((a, b) => a.number - b.number)
      .map(issue => ({ number: issue.number, issueId: issue.id, status: 'pending' as const }));
    return this.write({ id, repo: args.repo, requestId: args.requestId, catId: args.catId, threadId,
      ownerUserId: owner.userId, ownerOperationId: owner.requestId, createdAt: Date.now(),
      status: items.length ? 'paused' : 'completed', items }, null);
  }
  async control(input: unknown, owner: PluginOwnerOperationContext) {
    const args = idInput.extend({ expectedRevision: z.number().int().positive(),
      status: z.enum(['running', 'paused', 'stopped']) }).parse(input);
    const { revision, ...queue } = await this.read(args.id);
    if (queue.ownerUserId && queue.ownerUserId !== owner.userId) throw new Error('Classification queue belongs to another owner');
    if (revision !== args.expectedRevision) throw new Error('Classification queue revision changed; refresh first');
    if (queue.status === 'stopped') throw new Error('Stopped queue cannot resume; prepare a new queue');
    if (args.status === 'running') await this.validateTarget(queue);
    queue.status = args.status; delete queue.error;
    const saved = await this.write(queue, revision);
    return args.status === 'running' ? this.pump(saved) : saved;
  }
  private async validateTarget(queue: ClassificationQueue) {
    await this.driver.allowed(queue.repo);
    if (queue.origin === 'integration' && await this.context.config.get('initialClassification') !== true) throw new Error('首次自动分类已关闭；原进度保留');
    if (await this.context.config.get('analysisThreadId') !== queue.threadId) throw new Error('Analysis thread changed; original queue retained');
    await this.driver.target(queue.threadId, queue.catId);
  }
  async recover() {
    for (const queue of await this.list()) if (queue.status === 'running') await this.pump(queue);
  }
  private async pump(view: ClassificationQueueView) {
    let { revision, ...queue } = view;
    if (queue.status !== 'running') return view;
    try {
      await this.validateTarget(queue);
      delete queue.error;
      for (const item of queue.items) {
        if (item.status === 'analyzed' || item.status === 'skipped') continue;
        // Persist the deterministic job reference before its first delivery.
        item.jobId ??= hash(['classification-queue-job', queue.id, item.issueId]);
        item.status = 'waiting';
        revision = (await this.write(queue, revision)).revision;
        const job = await this.driver.job(queue, item);
        if (!job) { item.status = 'skipped'; item.reason = '问题已关闭；本队列仅研判 Open 问题'; continue; }
        if (job.analysis) { item.status = 'analyzed'; delete item.reason; continue; }
        item.reason = job.error;
        return this.write(queue, revision);
      }
      queue.status = 'completed';
    } catch (error) {
      await this.driver.authorized();
      queue.error = error instanceof Error ? error.message.slice(0, 300) : 'Classification queue unavailable';
    }
    return this.write(queue, revision);
  }
}
