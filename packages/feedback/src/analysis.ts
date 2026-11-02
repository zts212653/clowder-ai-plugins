import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { collectEvidence } from './collect-evidence.js';
import { analysisKey, digest, feedbackTitle, record, text } from './config.js';
import { instructions, recipeVersion } from './recipe.js';
import { sanitize } from './sanitize.js';
import { parseReport } from './report.js';
import type { Host, OwnerContext } from './types.js';

export type Analysis = {
  id: string; owner: string; threadId: string; threadUrl: string; projectRef: string; hash: string; material: string;
  state: 'preparing' | 'prepared' | 'starting' | 'running' | 'blocked' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  activationId: string;
  catId?: string; messageId?: string; triggerMessageId?: string; executionId?: string;
  candidate?: { title: string; body: string }; outcome?: string; error?: string;
  startedAt?: number; progress?: string; receivedChars?: number;
  journalDigest?: string;
  kind?: 'bug' | 'feat';
};

/** Feedback jobs use ordinary threads and Host deliveries. No model or Client
 * implementation is selected or launched by this package. */
export class FeedbackAnalysis {
  private readonly activationId = randomUUID();
  constructor(private readonly host: Host) {}

  private async update(key: string, change: (current: Analysis) => Analysis, expectedId?: string) {
    const stored = await this.host.storage.get(key);
    if (!stored) throw new Error('分析记录不存在，请重新准备材料');
    const current = stored.value as Analysis;
    if (expectedId !== undefined && current.id !== expectedId) throw new Error('该轮分析已失效，请检查当前准备记录');
    const next = change(current);
    if (next === current) return current;
    if (['starting', 'running', 'blocked'].includes(next.state) && next.messageId && next.triggerMessageId === next.messageId && next.outcome) {
      next.state = next.outcome === 'completed' && next.candidate ? 'ready' : 'failed';
      next.error = next.state === 'failed' ? '分析已结束，但没有有效报告；可重新分析或直接反馈。' : undefined;
    }
    if (!(await this.host.storage.compareAndSet(key, stored.revision, next)).applied) throw new Error('分析状态已变化，请重新打开检查');
    return next;
  }

  async status(userId: string, resume = false, feedbackId?: string) {
    const key = analysisKey(userId,feedbackId);
    const stored = await this.host.storage.get(key);
    if (!stored) return undefined;
    let run = stored.value as Analysis;
    // Ordinary response records are durable truth even if a live delivery was
    // missed, the panel was closed or this plugin was updated during analysis.
    if (run.messageId && this.host.threads?.readMessages && (['starting', 'running', 'blocked', 'interrupted'].includes(run.state) || run.state === 'failed' && run.outcome === 'completed')) {
      const rows = await this.host.threads.readMessages(run.threadId, {limit: 30}).catch(() => undefined);
      if (!rows) run = await this.update(key, current => ['starting','running','blocked','interrupted'].includes(current.state)
        ? {...current,state:'failed',error:'暂时无法读取分析对话；草稿已保留，可直接反馈或重新检查。'} : current,run.id);
      const reply = rows && [...rows].reverse().find(row => row.sender.kind === 'cat' && row.sender.catId === run.catId && row.response?.inputMessageIds.includes(run.messageId!));
      if (reply?.response) {
        const response = reply.response;
        if (response.status === 'completed') {
          const report = parseReport(reply.content);
          run = await this.update(key, current => !(['starting','running','blocked','interrupted'].includes(current.state) || current.state === 'failed' && current.outcome === 'completed') ? current : ({...current,
            state: report ? 'ready' : 'failed', outcome: 'completed',
            ...(report ? {candidate:{title:sanitize(current.kind ? feedbackTitle(current.kind,report.title) : report.title,[current.projectRef]),body:sanitize(report.body,[current.projectRef])}} : {}),
            error: report ? undefined : '分析已完成，但回复不是有效报告；可打开分析对话检查或重新分析。',
            progress: '分析完成，报告已整理', receivedChars: reply.content.length,
          }), run.id);
        } else if (response.status !== 'processing') {
          run = await this.update(key, current => ['starting','running','blocked','interrupted'].includes(current.state)
            ? {...current,state:'failed',error:'分析已停止或失败；草稿已保留，请打开分析对话查看。'} : current, run.id);
        } else {
          run = {...run, progress:reply.content.length ? '已收到 Agent 回复，正在等待本轮完成' : 'Agent 正在分析问题与诊断资料',receivedChars:reply.content.length};
        }
      }
    }
    if (run.activationId !== this.activationId && ['preparing', 'starting', 'running', 'blocked'].includes(run.state)) {
      run = await this.update(key, current => ({ ...current, state: 'interrupted', error: '插件曾停用或重启，无法核验上次分析是否完成；请打开原对话核对，或重新准备。' }));
    }
    if (resume && ['starting', 'running', 'blocked'].includes(run.state)) {
      try { await this.host.messaging?.subscribe({ threadId: run.threadId, method: 'feedback.delivery', includeOwnMessages: false }); }
      catch {
        run = await this.update(key, current => ({ ...current, state: 'failed', error: '无法恢复分析订阅；草稿已保留，可直接反馈或打开原对话查看。' }));
      }
    }
    return { id: run.id, state: run.state, threadUrl: run.threadUrl, error: run.error, hash: run.hash, material: run.material, recipeVersion, progress:run.progress,receivedChars:run.receivedChars,startedAt:run.startedAt,journalDigest:run.journalDigest,clientId:run.catId,projectRef:run.projectRef,
      ...(run.state === 'ready' ? run.candidate : {}) };
  }

  async dispatch(data: Record<string, unknown>, context: OwnerContext) {
    const feedbackId = data.feedbackId === undefined ? undefined : text(data.feedbackId,80);
    const key = analysisKey(context.userId,feedbackId);
    if (data.op === 'analysis-status') return { analysis: await this.status(context.userId,false,feedbackId) };
    if (data.op === 'cancel-analysis') {
      const run = await this.update(key, current => ({ ...current, state: 'cancelled' }));
      if (run.threadId) await this.host.messaging?.unsubscribe({ threadId: run.threadId }).catch(() => undefined); // Local cancellation already rejects later reports.
      return { analysis: await this.status(context.userId,false,feedbackId) };
    }
    const { threads, messaging, members, runtimeInfo } = this.host;
    if (!threads || !messaging || !members || !runtimeInfo) throw new Error('Host 缺少普通线程或运行信息能力，可直接提交或手动创建');
    if (data.op === 'prepare-analysis') {
      const previous = await this.host.storage.get(key);
      if (previous && (previous.value as Analysis).state === 'preparing') throw new Error('上次项目对话准备结果待核对；不会重复创建，请先检查或停止上次等待');
      if (previous && ['starting', 'running', 'blocked'].includes((previous.value as Analysis).state)) throw new Error('当前分析仍在进行，请先停止等待或回到报告');
      const environment = await runtimeInfo.get();
      const report = record(data.report);
      const title = text(report.title, 200); const body = text(report.body, 100_000);
      if (!title.trim()) throw new Error('请先填写反馈内容');
      const parentThreadId = data.parentThreadId === undefined || data.parentThreadId === '' ? undefined : text(data.parentThreadId, 500);
      const projectRef = parentThreadId || data.projectRef === undefined || data.projectRef === '' ? undefined : text(data.projectRef, 4096);
      const pending: Analysis = { id: randomUUID(), activationId: this.activationId, owner: context.userId, threadId: '', threadUrl: '', projectRef: '', hash: '', material: '', state: 'preparing', ...(data.clientId===undefined?{}:{catId:text(data.clientId,200)}), ...(report.kind === 'bug' || report.kind === 'feat' ? {kind:report.kind} : {}), ...(data.journalDigest === undefined ? {} : {journalDigest:text(data.journalDigest,64)}), error: '正在准备项目对话或结果待核对；不会自动重复创建。' };
      await context.assertCurrent();
      if (!(await this.host.storage.compareAndSet(key, previous?.revision ?? null, pending)).applied) throw new Error('分析准备已在另一个窗口变化，请重新检查');
      const thread = await threads.create({ title: '问题反馈分析', ...(parentThreadId ? { parentThreadId } : {}), ...(projectRef ? { projectRef } : {}) });
      const project = thread.projectRef ?? environment.projectRoot;
      await this.update(key, current => ({ ...current, threadId: thread.id, threadUrl: thread.deepLinkUrl, projectRef: project }), pending.id);
      await this.host.storage.compareAndSet(`analysis-thread:${thread.id}`, null, { key, id: pending.id });
      const roots = data.logs === true ? [{ path: environment.logDirectory, projectRoot: undefined }, { path: join(project, 'logs'), projectRoot: project }] : [];
      const collected = await Promise.allSettled(roots.map(root => collectEvidence(root.path, Date.now(), root.projectRoot)));
      const evidence = collected.map((result, index) => `E${index + 3} ${index === 0 ? '当前实例日志' : '所选项目 logs 目录'}\n${result.status === 'fulfilled' ? result.value : '无法读取此来源；覆盖存在缺口。'}`).join('\n\n');
      const material = sanitize(`E1 环境\nClowder ${environment.version}\n${environment.platform} ${environment.architecture} Node ${environment.nodeVersion}\n\nE2 用户现象\n${title}\n${body}\n\n${evidence || (report.kind==='feat'?'功能建议未采集故障日志。':'此次没有采集日志材料。')}`, [project, environment.projectRoot, environment.logDirectory]);
      await context.assertCurrent();
      const run = await this.update(key, current => ({ ...current, hash: digest({ material, recipeVersion, threadId: thread.id }), material, state: 'prepared', error: undefined }), pending.id);
      return { material, hash: run.hash, recipeVersion, analysis: await this.status(context.userId,false,feedbackId) };
    }
    if (data.op !== 'analyze') throw new Error('不支持的分析操作');
    const stored = await this.host.storage.get(key);
    const run = stored?.value as Analysis | undefined;
    if (!run || run.state !== 'prepared' || run.hash !== data.hash || data.confirmed !== true) throw new Error('请先检查并确认当前脱敏材料');
    const catId = text(data.clientId, 200);
    const member = await members.get(catId);
    if (!member?.available) throw new Error('所选成员目前不可用，可更换成员或直接反馈');
    await this.update(key, current => {
      if (current.state !== 'prepared') throw new Error('分析准备已变化，请重新检查');
      return { ...current, activationId: this.activationId, state: 'starting', catId,startedAt:Date.now(),progress:'分析请求已发送，等待 Agent 开始' };
    }, run.id);
    await messaging.subscribe({ threadId: run.threadId, method: 'feedback.delivery', includeOwnMessages: false });
    // The durable starting state makes an uncertain send visible, rather than
    // silently issuing a second invocation after a connection failure.
    const sent = await messaging.send({ threadId: run.threadId, idempotencyKey: `feedback-analysis:${run.id}`, wake: { catId },
      payload: { provenance: { epistemicStatus: 'user_intent' }, elements: [{ elementId: run.id, kind: 'text', payload: { text: `${instructions}\n\n${run.material}` } }] } });
    await this.update(key, current => ({ ...current, messageId: sent.messageId, state: current.state === 'starting' ? 'running' : current.state }), run.id);
    return { analysis: await this.status(context.userId,false,feedbackId) };
  }

  async receiveDelivery(input: unknown) {
    const delivery = record(input);
    const receipt = { deliveryId: text(delivery.deliveryId, 500) };
    const threadId = text(delivery.threadId, 500);
    const mapping = (await this.host.storage.get(`analysis-thread:${threadId}`))?.value as { key: string; id: string } | undefined;
    if (!mapping) return receipt;
    await this.update(mapping.key, run => {
      if (run.id !== mapping.id || !['starting', 'running', 'blocked'].includes(run.state)) return run;
      if (delivery.kind === 'execution_status') {
        if (delivery.state === 'started' && typeof delivery.replyTo === 'string' && (!run.messageId || delivery.replyTo === run.messageId)) {
          return { ...run, executionId: text(delivery.executionId, 500), triggerMessageId: delivery.replyTo };
        }
        if (delivery.executionId !== run.executionId) return run;
        if (delivery.state === 'blocked') return { ...run, state: 'blocked', error: sanitize(String(delivery.reason ?? 'Client 需要处理，请打开分析对话')) };
        if (delivery.state === 'resumed') return { ...run, state: 'running', error: undefined };
        if (delivery.state === 'settled' && delivery.chainDone === true) return { ...run, outcome: text(delivery.outcome, 30) };
        return run;
      }
      if (delivery.kind !== 'message' || !run.executionId || delivery.executionId !== run.executionId) return run;
      const envelope = record(delivery.envelope); const actor = record(envelope.actor);
      if (actor.kind !== 'cat' || actor.id !== run.catId) return run;
      const payload = record(envelope.payload);
      const content = (Array.isArray(payload.elements) ? payload.elements : []).map(record)
        .filter(element => element.kind === 'text').map(element => String(record(element.payload).text ?? '')).join('\n');
      const candidate = parseReport(content);
      if (!candidate) return run;
      return { ...run, candidate: { title: sanitize(run.kind ? feedbackTitle(run.kind,candidate.title) : candidate.title, [run.projectRef]), body: sanitize(candidate.body, [run.projectRef]) } };
    });
    return receipt;
  }
}
