import { createHash, randomUUID } from 'node:crypto';

const KEY = 'wechat-delegation.v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = new Set(['generating', 'prepared', 'submitting', 'queued', 'needs_review']);
const id = value => {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw Error('invalid coordinate');
  return value;
};
function clock(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
function inWindow(policy, at) {
  const { minute } = clock(at, policy.timeZone);
  return policy.windowStart < policy.windowEnd ? minute >= policy.windowStart && minute < policy.windowEnd
    : minute >= policy.windowStart || minute < policy.windowEnd;
}
function stopInState(state, ids) {
  for (const policyId of ids) { const policy = state.policies[policyId]; if (policy.mode !== 'revoked') { policy.mode = 'owner'; policy.ownerReason = 'manual'; policy.epoch++; } }
  for (const run of Object.values(state.runs)) if (ids.includes(run.policyId)) {
    if (['generating', 'prepared'].includes(run.phase)) run.phase = 'cancelled';
    if (run.submitted && pending.has(run.phase)) run.cancelRequested = true;
  }
  return ids;
}
// This catches explicit high-risk requests; it is not a claim that a text filter
// understands every scam. The model also has no payment, file or network tools.
export const sensitive = text => /验证码|密码|转账|收款|银行卡|助记词|私钥|付款|支付|签合同|是你本人|让本人|找真人|verification code|password|bank account|wire transfer|seed phrase|private key|https?:\/\/|www\./i.test(text);

/** Single durable journal. Its CAS is also the activation fence: a stale process
 * cannot join a later activation merely by loading its latest policies. */
export class DelegationService {
  constructor(options) { Object.assign(this, options); this.activation = randomUUID(); this.queue = Promise.resolve(); this.controllers = new Map(); }
  static async open(options) {
    const service = new DelegationService({ now: Date.now, ...options });
    await service.serial(async () => {
      const row = await service.storage.get(KEY);
      const state = row?.value ?? { schema: 1, policies: {}, runs: {}, cursors: {} };
      if (state.schema !== 1 || !state.policies || !state.runs || !state.cursors) throw Error('journal requires repair');
      state.activation = service.activation;
      state.globalControlEpoch = (state.globalControlEpoch ?? 0) + 1;
      for (const policy of Object.values(state.policies)) {
        if (policy.mode === 'active') policy.mode = 'paused';
        policy.epoch++;
      }
      for (const run of Object.values(state.runs)) {
        if (['generating', 'prepared'].includes(run.phase)) run.phase = 'cancelled';
        if (['submitting', 'queued'].includes(run.phase)) { run.phase = 'needs_review'; run.cancelRequested = true; }
      }
      const written = await service.storage.compareAndSet(KEY, row?.revision ?? null, state);
      if (!written.applied) throw Error('activation conflict');
    });
    return service;
  }
  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async load() {
    const row = await this.storage.get(KEY);
    if (!row || row.value.activation !== this.activation) throw Error('activation expired');
    return row;
  }
  async change(operation) {
    const row = await this.load();
    const state = structuredClone(row.value);
    const result = operation(state);
    const written = await this.storage.compareAndSet(KEY, row.revision, state);
    if (!written.applied) throw Error('journal revision conflict');
    return structuredClone(result);
  }
  async snapshot() {
    const { value, revision } = await this.load();
    return { revision, globalControlEpoch: value.globalControlEpoch, globalPause: value.globalPause === true, policies: Object.values(value.policies), runs: Object.values(value.runs), cursors: value.cursors };
  }
  active(policy) {
    if (!policy || policy.mode !== 'active') throw Error('delegation is paused or inactive');
    if (policy.expiresAt !== null && policy.expiresAt <= this.now()) throw Error('delegation expired');
  }
  current(state, run) {
    const policy = state.policies[run.policyId];
    return policy?.mode === 'active' && policy.epoch === run.epoch &&
      (policy.expiresAt === null || policy.expiresAt > this.now());
  }
  async activate(input, fence) {
    for (const key of ['accountId', 'accountIdentity', 'serverId', 'conversationId', 'catId']) id(input[key]);
    if (!['direct', 'group'].includes(input.kind) || (input.kind === 'group') !== input.conversationId.endsWith('@chatroom')) throw Error('conversation kind mismatch');
    if (!input.session?.sessionId || !Number.isSafeInteger(input.session.generation) || input.session.generation < 1) throw Error('isolated member session required');
    if (typeof input.proactive !== 'boolean' || typeof input.replies !== 'boolean' || (!input.proactive && !input.replies)) throw Error('choose delegation behavior');
    if (!Number.isSafeInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 1440 ||
        !Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000) throw Error('invalid conversation limits');
    for (const key of ['persona', 'goal']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000) throw Error('invalid persona or goal');
    if (input.expiresAt != null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now())) throw Error('invalid expiration');
    const schedule = { timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      windowStart: input.windowStart ?? 540, windowEnd: input.windowEnd ?? 1260, maxProactivePerDay: input.maxProactivePerDay ?? 2 };
    clock(this.now(), schedule.timeZone);
    if (![schedule.windowStart, schedule.windowEnd].every(value => Number.isInteger(value) && value >= 0 && value < 1440) || schedule.windowStart === schedule.windowEnd ||
        !Number.isInteger(schedule.maxProactivePerDay) || schedule.maxProactivePerDay < 1 || schedule.maxProactivePerDay > 20) throw Error('invalid proactive schedule');
    const policyId = hash([input.serverId, input.accountId, input.accountIdentity, input.conversationId]);
    const policy = await this.serial(() => this.change(state => {
      const old = state.policies[policyId];
      if (fence && ((old?.epoch ?? 0) !== fence.policyEpoch || state.globalControlEpoch !== fence.globalControlEpoch))
        throw Error('授权准备期间发生接管或配置变化，请重新确认');
      if (Object.values(state.runs).some(run => run.policyId === policyId && run.submitted && ['submitting', 'queued', 'needs_review'].includes(run.phase)))
        throw Error('请先核对该会话尚未确定的发送结果');
      for (const run of Object.values(state.runs)) if (run.policyId === policyId) {
        if (['generating', 'prepared'].includes(run.phase)) run.phase = 'cancelled';
        if (run.submitted && pending.has(run.phase)) run.cancelRequested = true;
      }
      state.policies[policyId] = { ...structuredClone(input), ...schedule, id: policyId, epoch: (old?.epoch ?? 0) + 1,
        mode: 'active', activatedAt: this.now(), nextAt: this.now() + input.intervalMinutes * 60000,
        turns: 0, unanswered: old?.unanswered ?? 0, proactiveDay: old?.proactiveDay ?? '', proactiveCount: old?.proactiveCount ?? 0,
        cursor: input.session.consumedCursor ?? 0, expiresAt: input.expiresAt ?? null };
      state.globalPause = false;
      return state.policies[policyId];
    }));
    for (const [runId, entry] of this.controllers) if (entry.policyId === policyId) { entry.controller.abort(); this.controllers.delete(runId); }
    return policy;
  }
  async takeover(policyId = null) {
    const affected = await this.serial(() => this.change(state => {
      if (policyId !== null && !state.policies[policyId]) throw Error('unknown conversation');
      if (policyId === null) { state.globalPause = true; state.globalControlEpoch++; }
      return stopInState(state, Object.values(state.policies).filter(p => policyId === null || p.id === policyId).map(p => p.id));
    }));
    for (const entry of this.controllers.values()) if (affected.includes(entry.policyId)) entry.controller.abort();
    // Cancellation/inspection is reconciled independently; the durable local
    // stop does not wait for the network and does not invent a remote receipt.
    return this.snapshot();
  }
  async initiate(policyId, operationId) { return this.run(policyId, 'proactive', id(operationId), null); }
  async incoming(accountId, message) {
    const snapshot = await this.snapshot();
    const policy = snapshot.policies.find(p => p.accountId === accountId && p.conversationId === message.threadId && p.mode === 'active' && p.replies);
    if (!policy || message.direction !== 'incoming' || !Number.isFinite(message.createdAt) || message.createdAt < policy.activatedAt ||
        typeof message.body !== 'string' || !message.body || message.body.length > 10000) return;
    return this.run(policy.id, 'reply', id(message.id), message.body);
  }
  async run(policyId, trigger, operationId, incomingText) {
    return this.execute(await this.admit(policyId, trigger, operationId, incomingText));
  }
  async admit(policyId, trigger, operationId, incomingText) {
    id(operationId);
    const runId = hash([policyId, trigger, operationId]);
    return this.serial(() => this.change(state => {
      const existing = state.runs[runId];
      if (existing) return { existing: true, run: existing };
      const policy = state.policies[policyId]; this.active(policy);
      if (trigger !== 'reply' && !policy.proactive || trigger === 'reply' && !policy.replies) throw Error('behavior not authorized');
      if (Object.values(state.runs).some(r => r.policyId === policyId && pending.has(r.phase))) throw Error('previous conversation turn unresolved');
      if (policy.turns >= policy.maxTurns) { policy.mode = 'paused'; return { skip: true }; }
      if (trigger !== 'reply') {
        const { day } = clock(this.now(), policy.timeZone);
        if (policy.proactiveDay !== day) { policy.proactiveDay = day; policy.proactiveCount = 0; }
        if (policy.unanswered >= 1 || policy.proactiveCount >= policy.maxProactivePerDay || trigger === 'scheduled' && !inWindow(policy, this.now())) return { skip: true };
        policy.proactiveCount++; policy.unanswered++;
      } else { policy.unanswered = 0; }
      policy.turns++; policy.cursor++; policy.nextAt = this.now() + policy.intervalMinutes * 60000;
      const run = { id: runId, policyId, epoch: policy.epoch, catId: policy.catId,
        accountId: policy.accountId, accountIdentity: policy.accountIdentity, serverId: policy.serverId,
        conversationId: policy.conversationId, trigger, operationId, incomingText,
        semanticCursor: policy.cursor, createdAt: this.now(), phase: incomingText && sensitive(incomingText) ? 'needs_owner' : 'generating', submitted: false };
      state.runs[runId] = run;
      if (run.phase === 'needs_owner') { policy.mode = 'owner'; policy.ownerReason = 'boundary'; policy.epoch++; }
      return { run, policy };
    }));
  }
  async execute(admitted) {
    if (admitted.skip) return;
    if (admitted.existing || admitted.run.phase === 'needs_owner') return admitted.run;
    const { id: runId, policyId } = admitted.run;
    const controller = new AbortController();
    try {
      const allowed = await this.serial(() => this.change(state => {
        const run = state.runs[runId];
        if (!this.current(state, run) || run.phase !== 'generating') { if (!run.submitted) run.phase = 'cancelled'; return false; }
        if (run.modelStarted) return false;
        run.modelStarted = true;
        this.controllers.set(runId, { controller, policyId });
        return true;
      }));
      if (!allowed) return;
      const output = await this.model.generate(admitted.run, admitted.policy, controller.signal);
      const prepared = await this.serial(() => this.change(state => {
        const run = state.runs[runId];
        if (!this.current(state, run) || controller.signal.aborted) { run.phase = 'cancelled'; return false; }
        if (!output || !['message', 'needs_owner', 'silent'].includes(output.kind) ||
            typeof output.text !== 'string' || output.text.length > 4000 || (output.kind === 'message' && !output.text.trim())) throw Error('invalid model output');
        run.text = output.text;
        if (output.kind === 'silent') { run.phase = 'silent'; state.policies[policyId].mode = 'paused'; state.policies[policyId].epoch++; return false; }
        if (output.kind === 'needs_owner' || sensitive(output.text)) {
          run.phase = 'needs_owner'; state.policies[policyId].mode = 'owner'; state.policies[policyId].ownerReason = 'boundary'; state.policies[policyId].epoch++; return false;
        }
        run.phase = 'prepared'; return true;
      }));
      if (!prepared) return;
      await this.channel.prepare(admitted.run);
      const started = await this.serial(async () => {
        const run = await this.change(state => {
          const row = state.runs[runId];
          if (!this.current(state, row) || row.phase !== 'prepared') { row.phase = 'cancelled'; return null; }
          row.phase = 'submitting'; row.submitted = true; return row;
        });
        if (!run) return null;
        // submit() starts its HTTP call before its first await. Release this
        // serial boundary with the promise wrapped, so takeover never waits for
        // a remote ACK, while the start and local stop have one defined order.
        return { promise: this.channel.submit(run) };
      });
      if (started) await this.receipt(runId, await started.promise);
    } catch (error) {
      await this.serial(() => this.change(state => {
        const run = state.runs[runId];
        if (run.phase === 'cancelled') return;
        run.phase = run.submitted ? 'needs_review' : 'failed';
        run.error = run.submitted ? '发送结果待核对；不会自动重发' : '本轮生成未完成；请检查后重新发起';
        if (this.current(state, run)) { state.policies[policyId].mode = 'paused'; state.policies[policyId].epoch++; }
      }));
    } finally { if (this.controllers.get(runId)?.controller === controller) this.controllers.delete(runId); }
    return (await this.snapshot()).runs.find(r => r.id === runId);
  }
  async receipt(runId, receipt, allowCancel = true) {
    const cancel = await this.serial(() => this.change(state => {
      const run = state.runs[runId];
      if (!run?.submitted || !receipt || typeof receipt.sendId !== 'string') throw Error('invalid send receipt');
      if (run.sendId && run.sendId !== receipt.sendId) throw Error('send identity mismatch');
      if (['cancelled', 'sent', 'owner_confirmed_sent'].includes(run.phase)) return null;
      run.sendId = receipt.sendId;
      run.phase = receipt.verified === true ? 'sent' : ['queued', 'submitting', 'accepted', 'cancelled', 'failed'].includes(receipt.state) ? receipt.state : 'needs_review';
      if (receipt.messageId) run.messageId = receipt.messageId;
      if (['needs_review', 'failed'].includes(run.phase) && this.current(state, run)) { state.policies[run.policyId].mode = 'paused'; state.policies[run.policyId].epoch++; }
      if (!this.current(state, run)) run.cancelRequested = true;
      return run.cancelRequested && ['queued', 'submitting'].includes(run.phase) ? run : null;
    }));
    if (cancel && allowCancel) {
      try { await this.receipt(runId, await this.channel.cancel(cancel), false); }
      catch { /* Local revocation is already durable; retain the unknown item. */ }
    }
  }
  async reconcile() {
    for (const run of (await this.snapshot()).runs) {
      if (!run.submitted || !['submitting', 'queued', 'needs_review', 'accepted'].includes(run.phase)) continue;
      try {
        const cancelling = run.cancelRequested && run.sendId && ['queued', 'submitting'].includes(run.phase);
        const receipt = cancelling ? await this.channel.cancel(run) : await this.channel.inspect(run);
        await this.receipt(run.id, receipt, !cancelling);
      } catch { /* No new POST: absence or network failure is not permission to resend. */ }
    }
  }
  async tick(at = this.now()) {
    for (const policy of (await this.snapshot()).policies) {
      if (policy.mode !== 'active' || !policy.proactive || policy.scheduleEnabled !== true || policy.nextAt > at || policy.turns >= policy.maxTurns ||
          policy.expiresAt !== null && policy.expiresAt <= at) continue;
      if (!inWindow(policy, at) || policy.unanswered >= 1) continue;
      try { await this.run(policy.id, 'scheduled', `scheduled:${policy.epoch}:${policy.nextAt}`, null); }
      catch { /* An unresolved prior turn remains visible and blocks further sending. */ }
    }
  }
  async cursor(accountId, value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('invalid event cursor');
    return this.serial(() => this.change(state => {
      if (BigInt(value) < BigInt(state.cursors[accountId] ?? '0')) throw Error('event cursor moved backwards');
      state.cursors[accountId] = value;
    }));
  }
  async confirmSeen(runId) {
    return this.serial(() => this.change(state => {
      const run = state.runs[runId];
      if (!run?.submitted) throw Error('该记录没有提交发送');
      run.phase = 'owner_confirmed_sent'; run.ownerObservedAt = this.now();
      return run;
    }));
  }
  async markNotified(runId) {
    return this.serial(() => this.change(state => { state.runs[runId].notified = true; }));
  }
  async revoke(policyId) {
    await this.takeover(policyId);
    return this.serial(() => this.change(state => { state.policies[policyId].mode = 'revoked'; }));
  }
  async ownerStop(source) {
    const affected = await this.serial(() => this.change(state => {
      state.ownerStops ??= {};
      if (state.ownerStops[source.messageId]) return [];
      const controlled = Object.values(state.policies).filter(p => p.notificationThreadId === source.threadId && p.ownerUserId === source.userId && p.activatedAt <= source.timestamp);
      if (!controlled.length) return [];
      state.ownerStops[source.messageId] = { threadId: source.threadId, userId: source.userId, timestamp: source.timestamp, global: source.global };
      if (source.global) { state.globalPause = true; state.globalControlEpoch++; }
      return stopInState(state, source.global ? Object.values(state.policies).filter(p => p.ownerUserId === source.userId).map(p => p.id) : controlled.map(p => p.id));
    }));
    for (const entry of this.controllers.values()) if (affected.includes(entry.policyId)) entry.controller.abort();
  }
}
