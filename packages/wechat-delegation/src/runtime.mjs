import { createHash, randomUUID } from 'node:crypto';
import { DelegationService } from './service.mjs';
import { MemberRunner } from './member-runner.mjs';
import { NativeSupervisor } from './native-supervisor.mjs';

const ACCOUNT = 'clowder';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalLogin = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'rejected', 'needs_login']);
const fields = new Set(['action', 'acceptThirdParty', 'target', 'catId', 'persona', 'goal', 'proactive', 'replies', 'scheduleEnabled',
  'intervalMinutes', 'maxTurns', 'expiresAt', 'confirm', 'policyId', 'operationId', 'runId', 'cursor', 'notificationThreadId', 'expectedEpoch', 'modelFingerprint',
  'timeZone', 'windowStart', 'windowEnd', 'maxProactivePerDay']);

export class DelegationRuntime {
  static async open(host, { supervisor = new NativeSupervisor({ dataPath: host.dataPath }), model = new MemberRunner(host), startTimer = true } = {}) {
    const runtime = new DelegationRuntime();
    Object.assign(runtime, { host, supervisor, model, jobs: new Set(), running: true, lastError: null });
    const channel = Object.fromEntries(['prepare', 'submit', 'inspect', 'cancel'].map(method => [method, (...args) => runtime.client()[method](...args)]));
    runtime.service = await DelegationService.open({ storage: host.storage, channel, model });
    supervisor.onExit = () => {
      if (!runtime.running) return;
      runtime.lastError = '账号连接组件已退出，代聊已停止；重新准备连接后仍需本人明确交回。';
      runtime.track(runtime.service.takeover(null));
    };
    for (const threadId of new Set((await runtime.service.snapshot()).policies.map(p => p.notificationThreadId).filter(Boolean)))
      await host.messaging.subscribe({ threadId, method: 'wechat.ownerDelivery' });
    if (startTimer) {
      runtime.timer = setInterval(() => {
        if (!runtime.polling && runtime.running && supervisor.client) {
          runtime.polling = runtime.cycle().catch(() => { runtime.lastError = '消息通道检查未完成，代聊可能已暂停；请查看会话状态。'; }).finally(() => { runtime.polling = null; });
        }
      }, 1000);
      runtime.timer.unref();
    }
    return runtime;
  }
  client() { if (!this.running || !this.supervisor.client) throw Error('请先准备账号连接组件'); return this.supervisor.client; }
  async requireOwner(context) {
    if (context?.kind !== 'owner-http-request' || context.operation !== 'write' || !context.requestIdentity?.requestId ||
        context.pluginInstanceId !== this.host.pluginInstanceId || !context.userId || typeof context.assertCurrent !== 'function') throw Error('操作需要已登录本人的 owner HTTP 上下文');
    context.signal.throwIfAborted(); await context.assertCurrent();
    if (!this.running) throw Error('插件已停止');
  }
  track(promise) {
    const job = promise.catch(() => { this.lastError = '本轮代聊未完成，请查看持久记录；不会自动重发。'; }).finally(() => this.jobs.delete(job));
    this.jobs.add(job); return job;
  }
  async drain() { await Promise.all([...this.jobs]); }
  async status({ probe = true } = {}) {
    const snapshot = await this.service.snapshot();
    let account = this.supervisor.client ? this.lastAccount ?? null : null;
    if (this.supervisor.client && probe) {
      try { account = await this.supervisor.client.identity(ACCOUNT); }
      catch { account = { connected: false, state: 'unknown' }; }
      this.lastAccount = account; this.accountObservedAt = Date.now();
    }
    return { ...snapshot, runtime: this.supervisor.client ? 'running' : 'dormant', account, accountIsLive: Boolean(probe && this.supervisor.client), accountObservedAt: this.accountObservedAt ?? null, storagePath: this.host.dataPath,
      memberRuntimeAvailable: this.model.available(), lastError: this.lastError,
      // Credentials and provider session data are never part of the page projection.
      policies: snapshot.policies.map(({ session, ...policy }) => ({ ...policy,
        mode: policy.mode === 'active' && policy.expiresAt !== null && policy.expiresAt <= Date.now() ? 'expired' : policy.mode,
        model: session.runtime?.model ?? null, modelClient: session.runtime?.clientId ?? null })),
      runs: snapshot.runs.filter((run, index, all) => index >= all.length - 100 || run.submitted && ['submitting', 'queued', 'needs_review'].includes(run.phase)).reverse(), totalRuns: snapshot.runs.length };
  }
  async dispatch(input, context) {
    await this.requireOwner(context);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) throw Error('操作包含不支持的字段');
    const action = input.action;
    const activationBaseline = action === 'activate' ? await this.service.snapshot() : null;
    if (action === 'status') return this.status();
    if (action === 'prepare') {
      if (input.acceptThirdParty !== true) throw Error('请先确认第三方组件与客户端同步范围说明');
      await this.service.takeover(null);
      await this.supervisor.prepare(context);
      this.lastError = null;
      return this.status();
    }
    if (action === 'pause_all' || action === 'takeover' || action === 'revoke') {
      const policyId = action === 'pause_all' ? null : input.policyId;
      if (policyId !== null && typeof policyId !== 'string') throw Error('请指定接管会话');
      await context.assertCurrent();
      const before = await this.service.snapshot();
      await this.service.takeover(policyId);
      if (action === 'revoke') await this.service.revoke(policyId);
      // Local stop is already durable; a failed provider revocation cannot undo it.
      for (const policy of before.policies.filter(p => policyId === null || p.id === policyId)) {
        try { if (this.host.memberSessions?.revoke) await this.host.memberSessions.revoke(policy.session.sessionId); } catch { /* Host/adapter outcome stays separate. */ }
      }
      return this.status({ probe: false });
    }
    if (action === 'confirm_seen') { await context.assertCurrent(); await this.service.confirmSeen(input.runId); return this.status({ probe: false }); }
    if (action === 'inspect') { await this.service.reconcile(); return this.status(); }
    if (action === 'history') {
      const all = (await this.service.snapshot()).runs;
      const end = input.cursor === undefined ? all.length : typeof input.cursor === 'string' && /^\d+$/.test(input.cursor) ? Number(input.cursor) : NaN;
      if (!Number.isSafeInteger(end) || end < 0 || end > all.length) throw Error('历史游标无效，请重新打开记录');
      const begin = Math.max(0, end - 50);
      return { items: all.slice(begin, end).reverse(), nextCursor: begin > 0 ? String(begin) : null, total: all.length };
    }
    const client = this.client();
    if (action === 'login' || action === 'login_poll') {
      // A persisted request key precedes the POST. If its ACK is lost, a retry
      // uses exactly that key and the daemon returns the original operation.
      const key = 'wechat-login.v1';
      let row = await this.host.storage.get(key);
      let record = row?.value;
      if (!record || terminalLogin.has(record.state)) {
        if (action === 'login_poll') return { state: record?.state ?? 'idle' };
        await this.service.takeover(null);
        const accounts = await client.json('v1/accounts');
        if (!accounts.items.some(item => item.id === ACCOUNT)) await client.createAccount(ACCOUNT);
        record = { nonce: randomUUID(), accountId: ACCOUNT, ownerUserId: context.userId, state: 'requesting', expiresAt: Date.now() + 300000 };
        await context.assertCurrent();
        const saved = await this.host.storage.compareAndSet(key, row?.revision ?? null, record);
        if (!saved.applied) throw Error('已有登录操作，请刷新并继续');
        row = await this.host.storage.get(key);
      }
      if (record.ownerUserId !== context.userId || record.accountId !== ACCOUNT) throw Error('登录操作归属不符');
      let operation;
      if (record.operationId) operation = await client.operation(ACCOUNT, record.operationId);
      else {
        if (record.expiresAt <= Date.now()) throw Error('原登录请求结果待核对，请先检查原账号状态');
        await context.assertCurrent(); operation = await client.login(ACCOUNT, record.nonce);
      }
      if (operation.accountId !== ACCOUNT || operation.kind !== 'login' || typeof operation.id !== 'string' ||
          record.operationId && record.operationId !== operation.id) throw Error('二维码与账号登录操作不匹配');
      const next = { ...record, operationId: operation.id, state: operation.state };
      await context.assertCurrent();
      const saved = await this.host.storage.compareAndSet(key, row.revision, next);
      if (!saved.applied) throw Error('登录状态已变化，请继续原操作');
      return { state: operation.state, ...(operation.result?.qrAvailable === true ? { qr: await client.qr(ACCOUNT, operation.id) } : {}),
        ...(operation.state === 'succeeded' ? { account: await client.identity(ACCOUNT) } : {}) };
    }
    if (action === 'chats') {
      const page = await client.threads(ACCOUNT, input.cursor ?? '');
      if (!Array.isArray(page.items)) throw Error('会话列表不可用');
      return { items: page.items.filter(chat => chat.accountId === ACCOUNT && ['direct', 'group'].includes(chat.kind)).map(chat => ({ id: chat.id, kind: chat.kind, displayName: chat.displayName ?? chat.id })), nextCursor: page.nextCursor ?? null };
    }
    if (action === 'cats') {
      return { items: (await this.host.members.list()).filter(member => member.available).map(member => ({ id: member.catId, label: member.displayName, model: member.defaultModel })),
        threads: (await this.host.threads.list({ limit: 100 })).map(thread => ({ id: thread.id, title: thread.title ?? thread.id })) };
    }
    if (action === 'cat_details') return this.model.describe(input.catId);
    if (action === 'activate') {
      if (input.confirm !== true || !this.model.available()) throw Error('请确认会话与模型数据范围；宿主必须支持受限成员执行');
      const identity = await client.identity(ACCOUNT);
      if (!identity.connected || !identity.accountIdentity) throw Error('微信账号身份尚未核验');
      const target = input.target;
      if (!target || typeof target.id !== 'string' || !['direct', 'group'].includes(target.kind) || Object.keys(target).some(key => !['id', 'kind'].includes(key))) throw Error('请选择具体好友或群');
      // Resolve the exact object from the real platform list, never a name guess.
      let cursor = '', chosen;
      const seen = new Set();
      do {
        const page = await client.threads(ACCOUNT, cursor);
        chosen = page.items.find(item => item.id === target.id && item.kind === target.kind && item.accountId === ACCOUNT);
        if (chosen) break;
        const next = page.nextCursor;
        if (next && seen.has(next)) throw Error('会话列表游标异常');
        seen.add(next); cursor = next ?? '';
      } while (cursor);
      if (!chosen) throw Error('该会话当前不在可核对的平台列表中');
      const members = await this.host.members.list();
      if (!members.some(member => member.catId === input.catId && member.available)) throw Error('所选猫当前不可用');
      const preview = await this.model.describe(input.catId);
      if (!preview.available || !input.modelFingerprint || preview.fingerprint !== input.modelFingerprint) throw Error('模型或账号配置已变化，请重新查看模型数据范围后确认');
      const policyId = digest([identity.serverId, ACCOUNT, identity.accountIdentity, target.id]);
      const previous = activationBaseline.policies.find(p => p.id === policyId);
      if ((previous?.epoch ?? 0) !== (input.expectedEpoch ?? 0)) throw Error('会话配置已变化，请刷新后再操作');
      const notificationThread = input.notificationThreadId ? await this.host.threads.get(input.notificationThreadId) : null;
      if (input.notificationThreadId && !notificationThread) throw Error('提醒目标对话不可用');
      await context.assertCurrent();
      const session = await this.model.prepare(input.catId, `wechat:${policyId}:${input.catId}`);
      if (session.runtime && (session.runtime.clientId !== preview.runtime?.clientId || session.runtime.model !== preview.runtime?.model ||
          preview.defaultAccountRef && session.runtime.account.accountRef !== preview.defaultAccountRef)) {
        await this.host.memberSessions.revoke(session.sessionId);
        throw Error('实际授权的模型服务与预览不符，请重新核验');
      }
      await context.assertCurrent();
      if (notificationThread) await this.host.messaging.subscribe({ threadId: notificationThread.id, method: 'wechat.ownerDelivery' });
      await this.service.activate({ serverId: identity.serverId, accountIdentity: identity.accountIdentity, accountId: ACCOUNT, conversationId: target.id, kind: target.kind,
        displayName: chosen.displayName ?? target.id, catId: input.catId, catDisplayName: members.find(member => member.catId === input.catId).displayName, ownerUserId: context.userId,
        persona: input.persona, goal: input.goal, proactive: input.proactive, replies: input.replies,
        scheduleEnabled: input.scheduleEnabled === true, intervalMinutes: input.intervalMinutes, maxTurns: input.maxTurns,
        timeZone: input.timeZone, windowStart: input.windowStart, windowEnd: input.windowEnd, maxProactivePerDay: input.maxProactivePerDay,
        expiresAt: input.expiresAt ?? null, notificationThreadId: input.notificationThreadId ?? null, notificationThreadTitle: notificationThread?.title ?? null, session },
      { policyEpoch: previous?.epoch ?? 0, globalControlEpoch: activationBaseline.globalControlEpoch });
      if (previous && previous.session.sessionId !== session.sessionId) {
        try { await this.host.memberSessions?.revoke(previous.session.sessionId); } catch { /* Old local epoch is already revoked. */ }
      }
      this.lastError = null;
      return this.status();
    }
    if (action === 'initiate') {
      const policy = (await this.service.snapshot()).policies.find(p => p.id === input.policyId);
      this.service.active(policy);
      if (!policy.proactive) throw Error('该会话尚未允许主动发起');
      if (policy.unanswered >= 1) throw Error('上次主动消息尚未收到回复，已停止继续追问。');
      if (typeof input.operationId !== 'string' || input.operationId.length > 200) throw Error('缺少原始主动开口操作标识');
      await context.assertCurrent();
      const admitted = await this.service.admit(policy.id, 'proactive', input.operationId, null);
      if (admitted.skip) throw Error('已达到本次主动聊天的频率或轮数限制，请先核对原策略。');
      this.track(this.service.execute(admitted));
      return { accepted: true, message: '已接收主动开口请求，请查看本会话实际结果。' };
    }
    if (action === 'disconnect') {
      await this.service.takeover(null);
      const result = await client.disconnect(ACCOUNT);
      return { locallyStopped: true, remoteResult: result };
    }
    throw Error('不支持的插件操作');
  }
  async cycle() {
    const client = this.client();
    await this.service.reconcile();
    await this.notify();
    const snapshot = await this.service.snapshot();
    const active = snapshot.policies.filter(p => p.mode === 'active');
    if (!active.length) return;
    try { for (const policy of active) await client.prepare(policy); }
    catch { for (const policy of active) await this.service.takeover(policy.id); this.lastError = '账号状态或身份已变化，代聊已停止；请重新核验。'; return; }
    const page = await client.events(ACCOUNT, snapshot.cursors[ACCOUNT] ?? '0');
    if (!Array.isArray(page.items)) throw Error('事件通道不可用');
    for (const event of page.items) {
      if (!event || typeof event.cursor !== 'string' || !/^\d+$/.test(event.cursor)) throw Error('事件游标不可用');
      const policy = active.find(p => p.conversationId === event.data?.threadId);
      if (policy && event.kind === 'message.committed' && Date.parse(event.createdAt) >= policy.activatedAt) {
        const message = await client.message(ACCOUNT, event.data.messageId);
        if (message.accountId !== ACCOUNT || message.threadId !== policy.conversationId || message.id !== event.data.messageId) throw Error('入站会话身份不符');
        await this.service.incoming(ACCOUNT, { ...message, createdAt: Date.parse(message.createdAt) });
      }
      await this.service.cursor(ACCOUNT, event.cursor);
    }
    this.track(this.service.tick());
    await this.notify();
  }
  async notify() {
    const state = await this.service.snapshot();
    for (const run of state.runs.filter(item => item.phase === 'needs_owner' && !item.notified)) {
      const policy = state.policies.find(item => item.id === run.policyId);
      if (!policy?.notificationThreadId) continue;
      await this.host.messaging.send({ threadId: policy.notificationThreadId, identity: 'wechat-delegation', idempotencyKey: `wechat-owner:${run.id}`,
        payload: { provenance: { origin: { kind: 'plugin', instanceId: this.host.pluginInstanceId }, epistemicStatus: 'observation' },
          elements: [{ elementId: 'handoff', kind: 'text', payload: { text: `微信会话「${policy.displayName}」需要本人处理，猫已暂停代聊。请在微信代聊插件中查看并接管。` } }] } });
      await this.service.markNotified(run.id);
    }
  }
  async ownerDelivery(input) {
    if (!input || typeof input.deliveryId !== 'string') throw Error('invalid delivery');
    const receipt = { deliveryId: input.deliveryId };
    if (!this.running || input.kind !== 'message' || typeof input.threadId !== 'string' || typeof input.envelope?.messageId !== 'string') return receipt;
    const policies = (await this.service.snapshot()).policies.filter(p => p.notificationThreadId === input.threadId);
    if (!policies.length) return receipt;
    const message = await this.host.messaging.get(input.envelope.messageId);
    if (!message || message.id !== input.envelope.messageId || message.threadId !== input.threadId || message.catId !== null || message.source ||
        message.from?.kind !== 'user' || message.from.userId !== message.userId || message.deliveryStatus === 'canceled' ||
        !Number.isFinite(message.timestamp) || !policies.some(p => p.ownerUserId === message.userId)) return receipt;
    const command = message.content.trim();
    const global = ['暂停全部代聊', '全部停一下', '/pause-all'].includes(command);
    if (!global && !['我来聊', '暂停这边的代聊', '/takeover'].includes(command)) return receipt;
    await this.service.ownerStop({ messageId: message.id, threadId: message.threadId, userId: message.userId, timestamp: message.timestamp, global });
    return receipt;
  }
  async stop() {
    clearInterval(this.timer);
    if (!this.running) return;
    try { await this.service.takeover(null); } finally { this.running = false; await this.supervisor.stop(); }
    await this.drain();
  }
}
