import { randomUUID } from 'node:crypto';
import { attachments } from './attachments.js';
import { AttachmentVault } from './attachment-vault.js';
import { FeedbackAnalysis } from './analysis.js';
import { digest, feedbackKey, feedbackTitle, profiles, record, text } from './config.js';
import { FeedbackRecords } from './records.js';
import { marker, provider } from './providers.js';
import { sanitize } from './sanitize.js';
import type { Host, Journal, OwnerContext, Profile, Provider, Report } from './types.js';

type ProviderFactory = (target: Profile) => Provider;
export class FeedbackService {
  private readonly analysis: FeedbackAnalysis;
  private readonly records: FeedbackRecords;
  constructor(private readonly host: Host, private readonly factory: ProviderFactory = target => provider(host, target)) {
    this.analysis = new FeedbackAnalysis(host);
    this.records = new FeedbackRecords(host);
  }

  receiveDelivery(input: unknown) { return this.analysis.receiveDelivery(input); }

  async dispatch(input: unknown, context: OwnerContext | undefined): Promise<unknown> {
    if (context?.kind !== 'owner-http-request' || context.operation !== 'write' || !context.requestIdentity || context.pluginInstanceId !== this.host.pluginInstanceId) throw new Error('反馈仅能由已登录用户在插件面板中操作');
    await context.assertCurrent();
    const data = record(input); const op = text(data.op, 30);
    const targets = await profiles(this.host);
    const feedbackId = data.feedbackId === undefined ? undefined : text(data.feedbackId,80);
    if (feedbackId !== undefined && !/^[\w-]{1,80}$/.test(feedbackId)) throw new Error('反馈记录 ID 无效');
    if (['bootstrap','history'].includes(op)) await this.records.migrate(context.userId,targets);
    if (op === 'history') return {items:await this.history(context.userId)};
    if (op !== 'save' && op !== 'bootstrap' && !feedbackId) throw new Error('请先选择反馈记录');
    const key = feedbackKey(context.userId, feedbackId ?? randomUUID());
    const current = await this.host.storage.get(key);
    const journal = current?.value as Journal | undefined;
    const vault = new AttachmentVault(this.host.dataPath);
    const present = async (value: Journal, revision: number | undefined, extra = {}) => ({ journal: await vault.hydrate(value), revision, ...extra });
    const write = async (value: Journal) => {
      await context.assertCurrent();
      await this.records.register(context.userId,value.id);
      await context.assertCurrent();
      const result = await this.host.storage.compareAndSet(key, current?.revision ?? null, {...value,updatedAt:Date.now()});
      if (!result.applied) throw new Error('草稿已在另一个窗口更新，请重新打开反馈面板');
      return { journal: value, revision: result.revision };
    };
    const publicWrite = async (value: Journal) => { const saved = await write(value); return present(saved.journal, saved.revision); };
    if (op === 'bootstrap') {
      const [members, runtime] = await Promise.allSettled([
        this.host.members?.list() ?? Promise.resolve([]),
        this.host.runtimeInfo?.get(),
      ]);
      if (feedbackId && !journal) throw new Error('反馈记录不存在或不属于当前用户');
      return { targets, journal: journal ? await vault.hydrate(journal) : undefined, revision: current?.revision, items:await this.history(context.userId),
        clients: members.status === 'fulfilled' ? members.value.filter(member => member.available).map(member => ({ id: member.catId, label: member.displayName, model: member.defaultModel })) : [],
        projectRoot: runtime.status === 'fulfilled' ? runtime.value?.projectRoot : undefined,
        analysis: feedbackId ? await this.analysis.status(context.userId,true,feedbackId) : undefined };
    }
    if (['prepare-analysis', 'analyze', 'analysis-status', 'cancel-analysis'].includes(op)) {
      if (!journal || journal.owner !== context.userId) throw new Error('反馈记录不存在');
      if (op === 'prepare-analysis' && ['writing','unknown','upload_failed','published'].includes(journal.state)) throw new Error('此记录暂不能重新分析，可以新建另一条反馈');
      return this.analysis.dispatch({...data,feedbackId:journal.id,report:(await vault.hydrate(journal)).report,journalDigest:journal.digest},context);
    }
    if (op === 'save') {
      if (journal && ['writing', 'unknown', 'upload_failed'].includes(journal.state)) throw new Error('请先处理上一次提交或保留上传回执，再编辑新报告');
      if (journal?.state === 'published') throw new Error('此反馈已投递，请新建另一条反馈');
      if (journal && data.revision !== current?.revision) throw new Error('草稿版本已变化，请重新打开');
      const target = targets.find(p => p.id === data.targetId);
      if (!target) throw new Error('反馈目标已变化');
      const report = await vault.storeReport(this.report(data.report));
      if (data.draftOnly !== true && !report.body.trim() && !report.attachments.length) throw new Error('请描述问题或添加图片');
      const id = journal?.id ?? feedbackId ?? key.split(':').at(-1)!;
      const value: Journal = {
        version: 1, id,
        owner: context.userId, report, target, digest: digest({ id, report, target }), state: 'draft',
        createdAt:journal?.createdAt ?? Date.now(),reviewReady:data.draftOnly !== true,
      };
      return publicWrite(value);
    }
    if (!journal || journal.owner !== context.userId || data.digest !== journal.digest) throw new Error('报告版本已变化，请重新检查并确认');
    if (digest(targets.find(p => p.id === journal.target.id)) !== digest(journal.target)) throw new Error('目标配置已变化，请重新检查报告');
    const adapter = this.factory(journal.target);
    if (op === 'preflight') return adapter.preflight(context.signal);
    if (op === 'manual') {
      if (!['draft','approved'].includes(journal.state)) throw new Error('请先核对当前提交结果');
      return publicWrite({...journal,handoffAt:Date.now()});
    }
    if (op === 'reset-upload') {
      if (journal.state !== 'upload_failed' || data.confirmed !== true) throw new Error('当前提交不能重新编辑');
      const archived = await this.host.storage.compareAndSet(`publication:${journal.id}`, null, journal);
      if (!archived.applied && digest((await this.host.storage.get(`publication:${journal.id}`))?.value) !== digest(journal)) throw new Error('回执已变化，请重新打开面板检查状态');
      const id = randomUUID();
      const next: Journal = {...journal,id,digest:digest({id,report:journal.report,target:journal.target}),state:'draft',phase:undefined,uploads:undefined,uploadingHash:undefined,safeError:undefined,createdAt:Date.now()};
      await this.records.register(context.userId,id);
      await this.host.storage.compareAndSet(feedbackKey(context.userId,id),null,next);
      await write({...journal,supersededBy:id});
      return present(next,(await this.host.storage.get(feedbackKey(context.userId,id)))?.revision);
    }
    if (op === 'approve') {
      if (journal.state !== 'draft' || data.confirmed !== true) throw new Error('请检查报告和图片，并确认目标可见性');
      return publicWrite({ ...journal, state: 'approved' });
    }
    if (op === 'submit') {
      if (journal.state === 'published') return present(journal, current?.revision);
      if (journal.state !== 'approved') throw new Error('提交尚未确认或远端结果待核对，不会重复上传');
      const check = await adapter.preflight(context.signal);
      if (journal.report.attachments.length && !check.attachments) throw new Error('自动附件通路未配置，请手动创建并粘贴或上传图片');
      await context.assertCurrent();
      const approvedReport = await vault.readReport(journal.report);
      const locked = await write({ ...journal, state: 'writing', phase: 'uploading', uploads: [] });
      let revision = locked.revision;
      let pending: Journal = locked.journal;
      const checkpoint = async (next: Journal) => {
        const saved = await this.host.storage.compareAndSet(key, revision ?? null, next);
        if (!saved.applied) throw new Error('提交日志发生冲突；请核对远端结果');
        revision = saved.revision; pending = next;
      };
      try {
        const uploaded: string[] = [];
        for (const attachment of approvedReport.attachments) {
          await context.assertCurrent();
          await checkpoint({ ...pending, uploadingHash: attachment.sha256 });
          const markdown = await adapter.upload(attachment, journal.id, context.signal);
          uploaded.push(markdown);
          await checkpoint({ ...pending, uploads: [...(pending.uploads ?? []), { submissionId: journal.id, sha256: attachment.sha256, markdown }], uploadingHash: undefined });
        }
        const report = { ...journal.report, body: `${journal.report.body}${uploaded.length ? `\n\n## 截图\n${uploaded.join('\n\n')}` : ''}` };
        await checkpoint({ ...pending, report, phase: 'creating' });
        await context.assertCurrent();
        const issue = await adapter.create({ ...approvedReport, body: report.body }, journal.id, context.signal);
        await checkpoint({ ...pending, report, issue, state: 'unknown', phase: 'verifying' });
        const verified = await adapter.read(issue, context.signal);
        verify(pending, verified);
        await checkpoint({ ...pending, state: 'published', issue: verified });
        await this.host.storage.compareAndSet(`publication:${journal.id}`, null, pending);
        return present(pending, revision);
      } catch {
        const state = pending.phase === 'uploading' ? 'upload_failed' : 'unknown';
        try { await checkpoint({ ...pending, state, safeError: state === 'upload_failed' ? '附件上传未完成，Issue 尚未开始创建。已取得的回执已保留；不会自动重传。' : '提交结果尚未核实。请先核对远端；不会自动重发。' }); } catch { /* A persisted writing fence also prevents retries. */ }
        return present({ ...pending, state }, revision);
      }
    }
    if (op === 'reconcile') {
      if (!['writing', 'unknown', 'published'].includes(journal.state)) throw new Error('当前没有待核对的提交');
      if (journal.phase === 'uploading') return publicWrite({ ...journal, state: 'upload_failed', safeError: '在附件阶段中断，Issue 尚未开始创建。已保留远端回执，不会自动重传。' });
      const found = journal.issue ?? await adapter.reconcile(journal.id, context.signal);
      if (!found) return present({ ...journal, state: 'unknown' }, current?.revision, { message: '未找到唯一匹配记录；这不代表没有创建。请到目标页面人工核对，暂不允许重发。' });
      const verified = await adapter.read(found, context.signal);
      verify(journal, verified);
      return publicWrite({ ...journal, issue: verified, state: 'published', safeError: undefined });
    }
    throw new Error('不支持的反馈操作');
  }

  private report(value: unknown): Report {
    const r = record(value);
    if (r.kind !== undefined && r.kind !== 'bug' && r.kind !== 'feat') throw new Error('反馈类型无效');
    const title=sanitize(text(r.title ?? '',200)).replace(/[\r\n]/g,' '), body=sanitize(text(r.body ?? '',100_000));
    return { ...(r.kind ? {kind:r.kind} : {}),title:r.kind ? feedbackTitle(r.kind,title,body) : title || feedbackTitle('bug','',body),body,attachments:attachments(r.attachments ?? []) };
  }

  private async history(userId: string) {
    const journals=await this.records.list(userId);
    const items=await Promise.all(journals.map(async journal=>{
      const analysis=await this.analysis.status(userId,false,journal.id).catch(()=>({state:'unavailable',threadUrl:undefined,startedAt:undefined}));
      const status=journal.supersededBy ? 'retained' : journal.state==='published' ? 'published'
        : ['writing','unknown','upload_failed'].includes(journal.state) ? journal.state
        : journal.handoffAt ? 'manual' : ['preparing','prepared','starting','running','blocked'].includes(analysis?.state ?? '') ? analysis!.state
        : ['failed','interrupted','cancelled','unavailable'].includes(analysis?.state ?? '') ? analysis!.state
        : analysis?.state==='ready' || journal.reviewReady ? 'ready' : 'draft';
      return {id:journal.id,title:journal.report.title,kind:journal.report.kind ?? (/^feat:/i.test(journal.report.title)?'feat':'bug'),status,
        updatedAt:Math.max(journal.updatedAt ?? journal.createdAt ?? 0,analysis?.startedAt ?? 0),analyzed:analysis?.state==='ready',issueUrl:journal.issue?.url,threadUrl:analysis?.threadUrl};
    }));
    return items.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
}
function verify(journal: Journal, issue: { title: string; body: string }): void {
  if (issue.title !== journal.report.title || issue.body !== `${journal.report.body}\n\n${marker(journal.id)}`) throw new Error('远端正文与已确认内容不一致，需人工核对');
}
