import { randomUUID } from 'node:crypto';
import type { PluginThreadMessage, PluginThreadSummary } from '@clowder-ai/plugin-sdk';
import { attachments } from './attachments.js';
import { AttachmentVault } from './attachment-vault.js';
import { FeedbackAnalysis } from './analysis.js';
import { analysisKey, digest, feedbackKey, feedbackTitle, profiles, record, text } from './config.js';
import { FeedbackRecords } from './records.js';
import { marker, provider } from './providers.js';
import { parseReport } from './report.js';
import { sanitize, sanitizeThreadText } from './sanitize.js';
import type { Host, Journal, OwnerContext, Profile, Provider, Report, StoredAttachment, StoredFeedback } from './types.js';

type ProviderFactory = (target: Profile) => Provider;
const screenshotUploadTimeoutMs = 5 * 60_000;
const threadPageSize = 30;
export class RevisionConflictError extends Error { readonly code = 'revision_conflict'; }
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
    if (op === 'list-threads') {
      const rows = await this.host.threads?.list({ limit: threadPageSize, before: pageCursor(data.before, 'lastActiveAt') });
      if (!rows) throw new Error('当前宿主无法读取会话列表');
      const items = rows.map(({ id, title, lastActiveAt }) => ({ id, title, lastActiveAt }));
      const last = items.at(-1);
      return { items, next: items.length === threadPageSize && last ? { id:last.id, lastActiveAt:last.lastActiveAt } : undefined };
    }
    const targets = await profiles(this.host);
    if (op === 'thread-context') {
      const thread = await this.visibleThread(data.threadId);
      await this.records.migrate(context.userId, targets);
      const feedback = await this.history(context.userId, thread.id);
      if (!this.host.threads?.readMessages) return { feedback, messages: [] };
      const rows = await this.host.threads.readMessages(thread.id, { limit: threadPageSize, before: pageCursor(data.before, 'timestamp') });
      const first = rows[0];
      const messages = (await this.conversationSources(rows, thread, context.userId)).reverse().map(({ id, timestamp, kind, content }) => ({
        id, timestamp, kind, excerpt:content.slice(0,240), ...(kind==='owner' && content.length>240 ? {fullText:content} : {}),
      }));
      return { feedback, messages, next: rows.length === threadPageSize && first ? { id:first.id, timestamp:first.timestamp } : undefined };
    }
    const selectionKey = `feedback-selection:${digest(context.userId)}`;
    const remember = async (id: string | null) => {
      const selected = await this.host.storage.get(selectionKey);
      if (selected?.value === id) return true;
      await context.assertCurrent();
      return (await this.host.storage.compareAndSet(selectionKey, selected?.revision ?? null, id)).applied;
    };
    if (op === 'new') { await remember(null); return {}; }
    const resumeSelection = op === 'bootstrap' && data.resume === true && data.feedbackId === undefined;
    const resumed = resumeSelection ? (await this.host.storage.get(selectionKey))?.value as string | null | undefined : undefined;
    const feedbackId = data.feedbackId === undefined ? resumed ?? undefined : text(data.feedbackId,80);
    if (feedbackId !== undefined && !/^[\w-]{1,80}$/.test(feedbackId)) throw new Error('反馈记录 ID 无效');
    if (['bootstrap','history'].includes(op)) await this.records.migrate(context.userId,targets);
    if (op === 'history') return {items:await this.history(context.userId)};
    if (op !== 'save' && op !== 'bootstrap' && !feedbackId) throw new Error('请先选择反馈记录');
    const key = feedbackKey(context.userId, feedbackId ?? randomUUID());
    const current = await this.host.storage.get(key);
    const stored = current?.value as StoredFeedback | undefined;
    const deleted = Boolean(stored && 'deleted' in stored);
    const journal = stored && !('deleted' in stored) ? stored : undefined;
    if (deleted && op !== 'bootstrap') throw new Error('该草稿已删除，请返回反馈记录');
    const vault = new AttachmentVault(this.host.dataPath);
    const present = async (value: Journal, revision: number | undefined, extra = {}) => ({ journal: await vault.hydrate(value), revision, ...extra });
    const write = async (value: Journal) => {
      await context.assertCurrent();
      await this.records.register(context.userId,value.id);
      await context.assertCurrent();
      const result = await this.host.storage.compareAndSet(key, current?.revision ?? null, {...value,updatedAt:Date.now()});
      if (!result.applied) throw new RevisionConflictError('草稿已在另一个窗口更新，请另存为新草稿或重新打开');
      return { journal: value, revision: result.revision };
    };
    const publicWrite = async (value: Journal) => { const saved = await write(value); return present(saved.journal, saved.revision); };
    if (op === 'bootstrap') {
      const [members, runtime] = await Promise.allSettled([
        this.host.members?.list() ?? Promise.resolve([]),
        this.host.runtimeInfo?.get(),
      ]);
      if (feedbackId && !journal && !(resumeSelection && deleted)) throw new Error('反馈记录不存在或不属于当前用户');
      const opened = resumeSelection && journal?.state === 'published' ? undefined : journal;
      if (opened && opened.state !== 'published') await remember(opened.id);
      return { targets, journal: opened ? await vault.hydrate(opened) : undefined, revision: opened ? current?.revision : undefined, items:await this.history(context.userId),
        clients: members.status === 'fulfilled' ? members.value.filter(member => member.available).map(member => ({ id: member.catId, label: member.displayName, model: member.defaultModel })) : [],
        projectRoot: runtime.status === 'fulfilled' ? runtime.value?.projectRoot : undefined,
        analysis: opened ? await this.analysis.status(context.userId,true,opened.id) : undefined };
    }
    if (op === 'delete-draft') {
      if (!journal || journal.owner !== context.userId) throw new Error('草稿不存在或不属于当前用户');
      if (data.confirmed !== true) throw new Error('请确认删除此草稿');
      if (data.revision !== current?.revision) throw new RevisionConflictError('草稿已有更新，请刷新记录后再删除');
      if (journal.state !== 'draft' || journal.reviewReady || journal.handoffAt || journal.issue ||
          await this.host.storage.get(analysisKey(context.userId,journal.id))) {
        throw new Error('只有尚未进入分析或提交的草稿可以删除');
      }
      await context.assertCurrent();
      // A tombstone discards the draft content while fencing stale autosaves and legacy migration.
      const result = await this.host.storage.compareAndSet(key,current?.revision ?? null,{deleted:true});
      if (!result.applied) throw new RevisionConflictError('草稿已有更新，请刷新记录后再删除');
      return {items:await this.history(context.userId)};
    }
    if (op === 'analysis-members' || op === 'summarize-thread') {
      if (!journal || journal.owner !== context.userId || !journal.linkedThread) throw new Error('请先保存关联会话');
      const thread = await this.visibleThread(journal.linkedThread.id);
      const [cats, members] = await Promise.all([this.host.threads?.getCats?.(thread.id), this.host.members?.list()]);
      const routable = new Set(cats?.routableNow.map(cat => cat.catId));
      const clients = (members ?? []).filter(member => member.available && routable.has(member.catId))
        .map(member => ({id:member.catId,label:member.displayName,model:member.defaultModel}));
      if (op === 'analysis-members') return {clients};
      if (data.confirmed !== true) throw new Error('请确认使用会话文字生成草稿');
      if (!['draft','approved'].includes(journal.state)) throw new Error('此反馈不能重新填入总结，请新建一条反馈');
      if (data.revision !== current?.revision) throw new RevisionConflictError('草稿已有更新，请重新打开');
      const client = clients.find(member => member.id===journal.clientId) ?? clients[0];
      if (!this.host.threads?.readMessages) throw new Error('当前宿主无法读取会话文字');
      const before = pageCursor(data.before,'timestamp');
      const recent = await this.host.threads.readMessages(thread.id,{limit:60});
      const window = before ? [...await this.host.threads.readMessages(thread.id,{limit:threadPageSize,before}),...recent] : recent;
      const rows = await this.conversationSources([...new Map(window.map(row=>[row.id,row])).values()],thread,context.userId);
      const original = rows.filter(row=>row.kind==='owner');
      const findings = rows.filter(row=>row.kind==='analysis').slice(-5);
      if (!findings.length) throw new Error('还没有可供整理的成员分析');
      const draft = journal.report;
      const excerpts = (items:typeof rows) => items.map(row=>row.content.slice(0,1800)).join('\n\n') || '本次读取范围内没有相关文字。';
      const own = original.length>6 ? [original[0]!,...original.slice(-5)] : original;
      const kind = draft.kind ?? 'bug';
      const ownText = excerpts(own);
      const addition = sanitizeThreadText(draft.body,thread.projectRef ?? '',thread.id,thread.deepLinkUrl).trim();
      const formal = findings.length===1 && /^#\s+(?:bug|feat):/mu.test(findings[0]!.content) ? parseReport(findings[0]!.content) : undefined;
      const source = `## 我的原话\n\n${ownText}${addition ? `\n\n## 我的补充\n\n${addition}` : ''}`;
      if (formal || !client) {
        const title = feedbackTitle(kind, formal?.title ?? sanitizeThreadText(thread.title ?? '',thread.projectRef ?? '',thread.id,thread.deepLinkUrl), ownText);
        const report = { ...draft, kind, title, body:`## 已有分析\n\n${formal?.body ?? excerpts(findings)}\n\n${source}`.slice(0,100_000) };
        const saved = await publicWrite({...journal,report,state:'draft',reviewReady:true,digest:digest({id:journal.id,report,target:journal.target,linkedThreadId:thread.id})});
        return { ...saved, summarySource:formal?'reused':'combined' };
      }
      const material = `草稿类型：${kind}\n\n## 已有分析\n${excerpts(findings)}\n\n${source.slice(0,16_000)}`;
      const request = {feedbackId:journal.id,report:draft,clientId:client.id,journalDigest:journal.digest};
      const prepared = await this.analysis.dispatch({...request,op:'prepare-analysis'},context,thread,{material,source});
      return this.analysis.dispatch({...request,op:'analyze',hash:prepared.hash,confirmed:true},context,thread);
    }
    if (['prepare-analysis', 'analyze', 'analysis-status', 'cancel-analysis'].includes(op)) {
      if (!journal || journal.owner !== context.userId) throw new Error('反馈记录不存在');
      if (op === 'prepare-analysis' && ['writing','unknown','upload_failed','published'].includes(journal.state)) throw new Error('此记录暂不能重新分析，可以新建另一条反馈');
      const thread = journal.linkedThread && (op === 'prepare-analysis' || op === 'analyze')
        ? await this.visibleThread(journal.linkedThread.id) : undefined;
      return this.analysis.dispatch({...data,feedbackId:journal.id,report:(await vault.hydrate(journal)).report,journalDigest:journal.digest},context,thread);
    }
    if (op === 'save') {
      if (journal && ['writing', 'unknown', 'upload_failed'].includes(journal.state)) throw new Error('请先处理上一次提交或保留上传回执，再编辑新报告');
      if (journal?.state === 'published') throw new Error('此反馈已投递，请新建另一条反馈');
      if (journal && data.revision !== current?.revision) throw new RevisionConflictError('草稿版本已变化，请另存为新草稿或重新打开');
      const target = targets.find(p => p.id === data.targetId);
      if (!target) throw new Error('反馈目标已变化');
      const clientId = data.clientId === undefined ? journal?.clientId : text(data.clientId, 200);
      const requestedThread = data.linkedThreadId ?? (data.linkedThreadId === undefined ? journal?.linkedThread?.id : undefined);
      const thread = requestedThread === undefined ? undefined : await this.visibleThread(requestedThread);
      const linkedThread = thread ? { id: thread.id, title: thread.title, deepLinkUrl: thread.deepLinkUrl } : undefined;
      const projectRef = thread ? thread.projectRef : data.projectRef === undefined ? journal?.projectRef : text(data.projectRef, 4096);
      let inputReport = record(data.report);
      if (data.sourceMessageId !== undefined) {
        if (!thread || !this.host.threads?.readMessages) throw new Error('请先选择可读取的关联会话');
        const id = text(data.sourceMessageId, 256);
        const messages = await this.host.threads.readMessages(thread.id, { limit:threadPageSize, before:pageCursor(data.sourceBefore, 'timestamp') });
        const message = messages.find(item => item.id === id && importableMessage(item));
        if (!message) throw new Error('找不到所选回复，请重新打开会话查看');
        const content = sanitizeThreadText(message.content, thread.projectRef ?? '', thread.id, thread.deepLinkUrl);
        const source = parseReport(content);
        const existing = text(inputReport.body ?? '').trim();
        const imported = source?.body ?? content.trim();
        const body = existing ? `${existing}\n\n## 会话中的分析\n\n${imported}` : imported;
        inputReport = { ...inputReport, title: text(inputReport.title ?? '', 200).trim() || source?.title, body: body.slice(0, 100_000) };
      }
      const report = await vault.storeReport(this.report(inputReport));
      if (data.draftOnly !== true && !report.body.trim() && !report.attachments.length) throw new Error('请描述问题或添加图片');
      const id = journal?.id ?? feedbackId ?? key.split(':').at(-1)!;
      const value: Journal = {
        version: 1, id,
        owner: context.userId, report, target, digest: digest({ id, report, target, linkedThreadId:linkedThread?.id }), state: 'draft',
        clientId, projectRef, linkedThread,
        createdAt:journal?.createdAt ?? Date.now(),reviewReady:data.draftOnly !== true,
      };
      const saved = await publicWrite(value);
      // The journal is durable already; a resume-hint failure must not hide its new revision.
      return { ...saved, selectionSaved: await remember(id).catch(() => false) };
    }
    if (!journal || journal.owner !== context.userId || data.digest !== journal.digest) throw new Error('报告版本已变化，请重新检查并确认');
    if (op === 'sync-thread-issue') {
      if (journal.state !== 'published' || !journal.issue || !journal.linkedThread) throw new Error('请先核实已投递的 Issue 和关联会话');
      if (journal.linkedIssueMessageId) return present(journal, current?.revision);
      if (data.revision !== current?.revision) throw new RevisionConflictError('反馈记录已有更新，请重新打开');
      const messaging = this.host.messaging;
      if (!messaging) throw new Error('当前宿主无法向关联会话发送回执');
      const thread = await this.visibleThread(journal.linkedThread.id);
      const address = { threadId:thread.id, idempotencyKey:`feedback-issue:${journal.id}` };
      const original = await messaging.findSent?.(address);
      await context.assertCurrent();
      const sent = original ?? await messaging.send({ ...address,
        payload:{ provenance:{ epistemicStatus:'user_intent' }, elements:[{ elementId:journal.id, kind:'text', payload:{ text:`问题反馈已投递 · Issue #${journal.issue.id}\n${journal.issue.url}` } }] } });
      return publicWrite({ ...journal, linkedIssueMessageId:sent.messageId });
    }
    if (digest(targets.find(p => p.id === journal.target.id)) !== digest(journal.target)) throw new Error('目标配置已变化，请重新检查报告');
    if (op === 'preflight') {
      const target = journal.target;
      if (target.mode === 'manual') return { manualReason: 'target' };
      return this.factory(target).preflight(context.signal);
    }
    const adapter = this.factory(journal.target);
    if (['add-screenshots','remove-screenshot','upload-screenshots','check-screenshots','retry-screenshots','confirm-screenshots'].includes(op)) {
      const issue = journal.issue;
      if (journal.state !== 'published' || !issue) throw new Error('请先确认 Issue 已创建');
      if (data.revision !== current?.revision) throw new RevisionConflictError('反馈记录已有更新，请重新打开');
      if (op === 'confirm-screenshots') {
        if (data.confirmed !== true || !journal.screenshotCommentUnverified || journal.screenshotsConfirmed) {
          throw new Error('请先核对旧版截图记录并确认');
        }
        const updated = await publicWrite({...journal,screenshotsConfirmed:true});
        return {...updated,message:'已确认核对旧版截图。'};
      }
      const items = screenshotCandidates(journal);
      const sent = journal.screenshotSent ?? [];
      const attempt = journal.screenshotAttempt;
      const reconcileScreenshotAttempt = async () => {
        if (!attempt || !adapter.findIssueScreenshots) throw new Error('没有需要核对的截图');
        const found = await adapter.findIssueScreenshots(issue, attempt.hashes, attempt.id, attempt.startedAt, context.signal);
        if (found === undefined) return undefined;
        const updated = await publicWrite({...journal,screenshotAttempt:undefined,screenshotSent:[...sent,...found]});
        return {...updated,message: found.length === attempt.hashes.length ? '截图已添加到 Issue。' : '已核对上传结果，可重新选择剩余截图。'};
      };
      if (op === 'check-screenshots' || op === 'retry-screenshots') {
        if (!attempt) throw new Error('没有需要核对的截图');
        const retry = op === 'retry-screenshots';
        if (retry && data.confirmed !== true) throw new Error('请确认原 Issue 中没有这批截图');
        const reconciled = await reconcileScreenshotAttempt();
        if (reconciled) return reconciled;
        if (!retry) return present(journal, current?.revision, {message:'还未查到上传回执。可稍后再核对，或在 Issue 中确认没有这批截图后重新选择。'});
        if (!attempt.finished && Date.now() - attempt.startedAt < screenshotUploadTimeoutMs) {
          throw new Error('上次上传可能仍在处理，请稍后核对');
        }
        const updated = await publicWrite({...journal,screenshotAttempt:{...attempt,retryConfirmed:true}});
        return {...updated,message:'可以重新选择截图并上传到同一个 Issue。'};
      }
      if (attempt && !attempt.retryConfirmed) throw new Error('请先核对上次上传结果');
      if (op === 'add-screenshots') {
        const pictures = attachments(data.pictures).map(({original,...picture})=>picture);
        const existing = new Set(items.map(item => item.sha256));
        const toAdd = pictures.filter(picture => {
          if (existing.has(picture.sha256)) return false;
          existing.add(picture.sha256);
          return true;
        });
        if (items.length + toAdd.length > 4) throw new Error('最多保留 4 张截图，可先移除不需要的候选。');
        if (!toAdd.length) return present(journal, current?.revision);
        const retained = (await vault.readReport({title:'',body:'',attachments:items})).attachments;
        if ([...retained,...toAdd].reduce((sum,picture)=>sum+Buffer.byteLength(picture.base64,'base64'),0)>8_000_000) {
          throw new Error('发送图片总大小不能超过 8 MB');
        }
        const stored = await vault.storeReport({title:'',body:'',attachments:toAdd});
        return publicWrite({...journal,screenshotItems:[...items,...stored.attachments]});
      }
      if (op === 'remove-screenshot') {
        const hash = text(data.hash,64);
        if (sent.includes(hash) || !items.some(item => item.sha256 === hash)) throw new Error('请选择尚未上传的截图');
        return publicWrite({...journal,screenshotItems:items.filter(item => item.sha256 !== hash)});
      }
      if (!Array.isArray(data.hashes) || !data.hashes.length || data.hashes.length > 4 || data.confirmed !== true) {
        throw new Error('请选择要上传的截图并确认');
      }
      const selectedHashes = new Set<unknown>(data.hashes);
      const selected = items.filter(item => selectedHashes.has(item.sha256) && !sent.includes(item.sha256));
      if (selected.length !== selectedHashes.size || data.hashes.length !== selectedHashes.size) throw new Error('截图选择已变化，请重新选择');
      const check = await adapter.preflight(context.signal, true);
      if (journal.target.provider === 'organization-cli' || !adapter.attachToIssue || (!check.attachments && !check.githubCliAttachments)) {
        throw new Error(check.githubAttachmentLimit === 'permission' ? '当前账号没有目标仓库写权限。可更换访问令牌或 GitHub CLI 登录后重试。'
          : check.githubAttachmentLimit === 'cli' ? '在本机安装或更新支持附件的 GitHub CLI 后，可在这里重试。'
          : '此目标暂不支持在插件内上传截图。');
      }
      const validated = await adapter.read(issue, context.signal);
      if (validated.url !== issue.url || validated.id !== issue.id || !validated.body.includes(marker(journal.id))) {
        throw new Error('Issue 已变化，无法确认截图的提交位置');
      }
      const pictures = (await vault.readReport({title:'',body:'',attachments:selected})).attachments;
      if (attempt) {
        const reconciled = await reconcileScreenshotAttempt();
        if (reconciled) return reconciled;
      }
      const batch = {id:randomUUID(),hashes:selected.map(item => item.sha256),startedAt:Date.now()};
      const staged = await write({...journal,screenshotAttempt:batch});
      await context.assertCurrent();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(screenshotUploadTimeoutMs)]);
      const found = await adapter.attachToIssue(validated, pictures, batch.id, signal).catch(() => undefined);
      const updated: Journal = found === undefined
        ? {...staged.journal,screenshotAttempt:{...batch,finished:true}}
        : {...staged.journal,screenshotAttempt:undefined,screenshotSent:[...sent,...found]};
      const saved = await this.host.storage.compareAndSet(key, staged.revision ?? null, {...updated,updatedAt:Date.now()});
      if (!saved.applied) throw new RevisionConflictError('上传记录已更新，请重新打开反馈');
      return present(updated, saved.revision, {message:found === undefined ? '上传结果待核对，请在此检查。'
        : found.length===selected.length ? '截图已添加到 Issue。' : '部分截图已添加，可选择剩余截图继续上传。'});
    }
    if (op === 'manual') {
      if (!['draft','approved'].includes(journal.state)) throw new Error('请先核对当前提交结果');
      return publicWrite({...journal,handoffAt:Date.now()});
    }
    if (op === 'reset-upload') {
      if (journal.state !== 'upload_failed' || data.confirmed !== true) throw new Error('当前提交不能重新编辑');
      const archived = await this.host.storage.compareAndSet(`publication:${journal.id}`, null, journal);
      if (!archived.applied && digest((await this.host.storage.get(`publication:${journal.id}`))?.value) !== digest(journal)) throw new Error('回执已变化，请重新打开面板检查状态');
      const id = randomUUID();
      const next: Journal = {...journal,id,digest:digest({id,report:journal.report,target:journal.target,linkedThreadId:journal.linkedThread?.id}),state:'draft',phase:undefined,uploads:undefined,uploadingHash:undefined,safeError:undefined,createdAt:Date.now()};
      await this.records.register(context.userId,id);
      await this.host.storage.compareAndSet(feedbackKey(context.userId,id),null,next);
      await write({...journal,supersededBy:id});
      return present(next,(await this.host.storage.get(feedbackKey(context.userId,id)))?.revision,
        { selectionSaved: await remember(id).catch(() => false) });
    }
    if (op === 'approve') {
      if (!['draft','approved'].includes(journal.state) || data.confirmed !== true) throw new Error('请检查报告，并确认目标可见性');
      if (journal.state === 'approved' && data.revision !== current?.revision) throw new RevisionConflictError('确认已在另一个窗口更新，请重新打开');
      return publicWrite({ ...journal, state: 'approved' });
    }
    if (op === 'submit') {
      if (journal.state === 'published') return present(journal, current?.revision);
      if (journal.state !== 'approved') throw new Error('提交尚未确认或远端结果待核对，不会重复上传');
      await adapter.preflight(context.signal);
      await context.assertCurrent();
      const locked = await write({ ...journal, state: 'writing', phase: 'creating', screenshotItems:uniqueScreenshotCopies(journal.report.attachments) });
      let revision = locked.revision;
      let pending: Journal = locked.journal;
      const checkpoint = async (next: Journal) => {
        const saved = await this.host.storage.compareAndSet(key, revision ?? null, next);
        if (!saved.applied) throw new Error('提交日志发生冲突；请核对远端结果');
        revision = saved.revision; pending = next;
      };
      try {
        await context.assertCurrent();
        const issue = await adapter.create({ ...journal.report, attachments:[] }, journal.id, context.signal);
        await checkpoint({ ...pending, issue, state: 'unknown', phase: 'verifying' });
        const verified = await adapter.read(issue, context.signal);
        verify(pending, verified);
        await checkpoint({ ...pending, state: 'published', issue: verified });
        await this.host.storage.compareAndSet(`publication:${journal.id}`, null, pending);
        return present(pending, revision);
      } catch {
        if (pending.state === 'published') return present(pending, revision);
        try { await checkpoint({ ...pending, state:'unknown', safeError:'提交结果尚未核实。请先核对远端；不会自动重发。' }); } catch { /* A persisted writing fence also prevents retries. */ }
        return present({ ...pending, state:'unknown' }, revision);
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

  private async visibleThread(value: unknown) {
    const id = text(value, 500);
    const rows = await this.host.threads?.list({ threadIds: [id] });
    const thread = rows?.find(row => row.id === id);
    if (!thread) throw new Error('该会话不存在或当前不可访问');
    return thread;
  }

  private async conversationSources(rows: readonly PluginThreadMessage[], thread: PluginThreadSummary, owner: string) {
    const items = await Promise.all(rows.map(async row => {
      if (!row.content.trim()) return undefined;
      let kind: 'analysis' | 'owner';
      if (importableMessage(row)) kind = 'analysis';
      else if (row.sender.kind === 'owner') {
        const message = await this.host.messaging?.get?.(row.id);
        if (!message || message.threadId!==thread.id || message.userId!==owner ||
            (message.from ? message.from.kind!=='user' : message.catId!==null)) return undefined;
        kind = 'owner';
      } else return undefined;
      return {id:row.id,timestamp:row.timestamp,kind,content:sanitizeThreadText(row.content,thread.projectRef ?? '',thread.id,thread.deepLinkUrl).trim().slice(0,4000)};
    }));
    return items.filter(item=>item!==undefined);
  }

  private async history(userId: string, threadId?: string) {
    let journals=await this.records.list(userId);
    if (threadId !== undefined) {
      const older = (await this.host.storage.get(`analysis-thread:${threadId}`))?.value as { key: string } | undefined;
      journals = journals.filter(({ journal }) => journal.linkedThread?.id === threadId ||
        (!journal.linkedThread && older?.key === analysisKey(userId, journal.id)));
    }
    const items=await Promise.all(journals.map(async ({journal,revision})=>{
      const analysis=await this.analysis.status(userId,false,journal.id).catch(()=>({state:'unavailable',threadUrl:undefined,startedAt:undefined}));
      const status=journal.supersededBy ? 'retained' : journal.state==='published' ? 'published'
        : ['writing','unknown','upload_failed'].includes(journal.state) ? journal.state
        : journal.handoffAt ? 'manual' : ['preparing','prepared','starting','running','blocked'].includes(analysis?.state ?? '') ? analysis!.state
        : ['failed','interrupted','cancelled','unavailable'].includes(analysis?.state ?? '') ? analysis!.state
        : analysis?.state==='ready' || journal.reviewReady ? 'ready' : 'draft';
      return {id:journal.id,title:journal.report.title,...(status==='draft'&&journal.state==='draft'?{deleteRevision:revision}:{}),kind:journal.report.kind ?? (/^feat:/i.test(journal.report.title)?'feat':'bug'),status,
        updatedAt:Math.max(journal.updatedAt ?? journal.createdAt ?? 0,analysis?.startedAt ?? 0),analyzed:analysis?.state==='ready',issueId:journal.issue?.id,issueUrl:journal.issue?.url,threadUrl:journal.linkedThread?.deepLinkUrl ?? analysis?.threadUrl,
        linkedThreadLabel:journal.linkedThread ? journal.linkedThread.title ?? '未命名会话' : undefined,
        screenshotsPending:journal.state==='published' && (journal.screenshotAttempt || (journal.screenshotCommentUnverified && !journal.screenshotsConfirmed))
          ? 'verify' : undefined};
    }));
    return items.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
}
function pageCursor<Key extends 'timestamp' | 'lastActiveAt'>(value: unknown, field: Key) {
  if (value === undefined) return undefined;
  const cursor = record(value);
  const position = cursor[field];
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) throw new Error('翻页位置无效，请刷新列表');
  return { id: text(cursor.id, field === 'timestamp' ? 256 : 500), [field]: position } as { id: string } & Record<Key, number>;
}
function importableMessage(message: PluginThreadMessage) {
  return message.sender.kind === 'cat' && (!message.response || message.response.status === 'completed') && Boolean(message.content.trim());
}
function screenshotCandidates(journal: Journal): StoredAttachment[] {
  if (journal.screenshotItems) return journal.screenshotItems;
  if (!journal.addScreenshotsLater || journal.screenshotsConfirmed) return [];
  return uniqueScreenshotCopies(journal.report.attachments);
}
function uniqueScreenshotCopies(items: StoredAttachment[]) {
  return [...new Map(items.map(({original,...item}) => [item.sha256,item])).values()];
}
function verify(journal: Journal, issue: { title: string; body: string }): void {
  if (issue.title !== journal.report.title || issue.body !== `${journal.report.body}\n\n${marker(journal.id)}`) throw new Error('远端正文与已确认内容不一致，需人工核对');
}
