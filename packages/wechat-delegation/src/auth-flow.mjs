import { createHash, randomUUID } from 'node:crypto';
import { NativeRequestError } from './native-stdio.mjs';
const KEY = 'wechat-auth.v2';
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'expired', 'rejected', 'lan_required']);
const activeNative = new Set(['starting', 'pending', 'scanned', 'completing', 'authenticating']);
const metadata = value => Object.fromEntries(['id', 'generation', 'sourceGeneration', 'accountGeneration', 'accountIdentity', 'phase', 'startedAtMs', 'updatedAtMs', 'authenticationMayHaveOccurred']
  .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

/** Host intent metadata only. The native service owns credentials and actual
 * authentication. Never replay an unknown start or silently change its nonce. */
export class AuthFlow {
  constructor({ storage, getClient, assertOwner, beforeStart = async () => {}, now = Date.now }) {
    Object.assign(this, { storage, getClient, assertOwner, beforeStart, now });
    this.queue = Promise.resolve(); this.jobs = new Map(); this.preparing = new Set(); this.qrs = new Map(); this.closed = false;
  }
  live() { if (this.closed) throw Error('authentication activation expired'); }
  serial(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async read() {
    this.live(); const row = await this.storage.get(KEY); this.live();
    const state = row?.value ?? { schema: 2, intents: {}, activeId: null };
    if (!row) {
      const legacy = await this.storage.get('wechat-login.v1'); this.live();
      if (legacy) {
        const old = legacy.value;
        if (typeof old?.ownerUserId !== 'string' || typeof old.nonce !== 'string') throw Error('旧认证记录需要修复，原件已保留');
        const id = `legacy:${createHash('sha256').update(old.nonce).digest('hex')}`;
        state.intents[id] = { id, kind: 'login', legacy: true, ownerUserId: old.ownerUserId, phase: 'interrupted', submitted: false,
          cancelRequested: false, unconfirmedAuthentication: true, native: null, sourceKey: 'wechat-login.v1',
          originalOperationId: typeof old.operationId === 'string' ? old.operationId : null };
        state.activeId = id;
      }
    }
    if (state.schema !== 2 || !state.intents || Array.isArray(state.intents) || state.activeId !== null && !state.intents[state.activeId]) throw Error('认证记录需要修复，原件已保留');
    return { row, state };
  }
  async change(operation) {
    const { row, state: previous } = await this.read(); const state = structuredClone(previous), result = operation(state);
    this.live(); const written = await this.storage.compareAndSet(KEY, row?.revision ?? null, state);
    if (!written.applied) throw Error('认证记录已变化，请继续原操作');
    return structuredClone(result);
  }
  own(record, context) { if (record && record.ownerUserId !== context.userId) throw Error('认证操作归属不符'); }
  projection(record, qr = false) {
    if (!record) return { state: 'idle' };
    const image = this.qrs.get(record.id);
    return { state: record.phase, kind: record.kind, operationId: record.id, cancelRequested: record.cancelRequested,
      source: record.native && record.phase === record.native.phase ? 'native' : 'host',
      ...(record.legacy ? { legacy: true, note: '旧组件认证记录已保留；新组件无法验证旧状态，不会重放。' } : {}),
      authenticationMayHaveOccurred: record.native?.authenticationMayHaveOccurred === true || record.unconfirmedAuthentication === true,
      ...(qr && image && ['pending', 'scanned'].includes(record.phase) ? { qr: `data:image/png;base64,${image.pngBase64}` } : {}) };
  }
  async status() { const { state } = await this.read(); return this.projection(state.intents[state.activeId]); }
  launch(record, client, slot, stage, operation) {
    const key = `${record.id}:${slot}`;
    let result;
    try { result = operation(); } catch (error) { result = Promise.reject(error); }
    const job = Promise.resolve(result).then(value => this.serial(() => this.accept(record, client, value, stage)), error => this.serial(() => this.failure(record, error, stage)))
      .catch(() => { this.problem = '认证记录更新未完成；请核对原操作，不会自动重新认证。'; })
      .finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
    this.jobs.set(key, job); return job;
  }
  async accept(expected, client, projection, stage) {
    this.live(); const native = metadata(expected.kind === 'login' ? projection.operation : projection);
    if (native.id !== expected.id) throw Error('认证回执身份不符');
    await this.change(state => {
      const record = state.intents[expected.id];
      if (!record || record.storeId !== expected.storeId || record.kind !== expected.kind) throw Error('认证来源已变化');
      if (record.native && terminal.has(record.native.phase)) {
        if (activeNative.has(native.phase)) return; // A late older observation cannot revive a terminal intent.
        if (record.native.phase !== native.phase) throw Error('认证终态不一致');
      }
      record.native = native;
      record.phase = record.cancelRequested && activeNative.has(native.phase) ? 'cancel_requested' : native.phase;
      if (terminal.has(native.phase) || stage === 'poll') record.unconfirmedAuthentication = false;
      record.updatedAt = this.now();
    });
    if (expected.kind === 'login' && projection.qr && !this.closed && this.getClient() === client) this.qrs.set(expected.id, { pngBase64: projection.qr.pngBase64 });
    else if (!activeNative.has(native.phase)) this.qrs.delete(expected.id);
  }
  async failure(expected, error, stage) {
    this.live(); await this.change(state => {
      const record = state.intents[expected.id];
      if (!record || terminal.has(record.phase)) return;
      const knownRefusal = stage === 'start' && error instanceof NativeRequestError && error.mayHaveCommitted === false;
      record.phase = knownRefusal ? 'failed' : 'unknown'; record.updatedAt = this.now();
      if (knownRefusal) record.unconfirmedAuthentication = false;
      // No raw exception or native diagnostics are journaled or returned.
    });
  }
  async begin(kind, context) {
    if (!['login', 'resume'].includes(kind)) throw Error('invalid authentication intent');
    await this.assertOwner(context); this.live(); const client = this.getClient(), identity = await client.identity('clowder');
    const selected = await this.serial(async () => {
      const { state } = await this.read(), current = state.intents[state.activeId]; this.own(current, context);
      if (current && !terminal.has(current.phase)) return { record: structuredClone(current), created: false };
      if (kind === 'login' && identity.credentialsAvailable) throw Error('已有保存的账号；请明确恢复，换账号前先断开原账号。');
      if (kind === 'resume' && (!identity.credentialsAvailable || identity.connected || !identity.accountIdentity)) throw Error('当前没有可明确恢复的离线保存会话');
      const record = { id: randomUUID(), kind, ownerUserId: context.userId, storeId: identity.nativeStoreId, instanceId: identity.serverId,
        accountGeneration: identity.accountGeneration, accountIdentity: identity.accountIdentity, phase: 'preparing', submitted: false, cancelRequested: false,
        unconfirmedAuthentication: false, native: null, createdAt: this.now(), updatedAt: this.now() };
      await this.change(state => { state.intents[record.id] = record; state.activeId = record.id; });
      this.preparing.add(record.id); return { record, created: true };
    });
    if (!selected.created) return this.poll(context, { allowApproval: false });
    try {
      await this.beforeStart();
      // Authority can expire while intent durability is being established. This
      // check stays outside the journal queue, so cancellation can pass it.
      await this.assertOwner(context);
      await this.serial(async () => {
        const { state } = await this.read(), current = state.intents[selected.record.id];
        if (!current || current.cancelRequested || terminal.has(current.phase)) return;
        if (this.getClient() !== client) throw Error('连接进程已变化，请核对原认证操作');
        const record = await this.change(state => {
          const record = state.intents[current.id]; record.phase = 'requesting'; record.submitted = true;
          record.unconfirmedAuthentication = kind === 'resume'; record.updatedAt = this.now(); return record;
        });
        if (context.signal.aborted) {
          await this.failure(record, new NativeRequestError('request_cancelled', false), 'start');
          context.signal.throwIfAborted();
        }
        // No await between this physical request start and releasing the queue.
        this.launch(record, client, 'network', 'start', () => kind === 'login' ? client.startLogin(record.id)
          : client.resume(record.id, { accountGeneration: record.accountGeneration, accountIdentity: record.accountIdentity }));
      });
    } finally { this.preparing.delete(selected.record.id); }
    return this.present(context, selected.record.id);
  }
  async present(context, operationId) {
    const { state } = await this.read(), record = state.intents[operationId ?? state.activeId]; this.own(record, context); return this.projection(record, true);
  }
  async poll(context, { allowApproval = true } = {}) {
    await this.assertOwner(context); this.live(); const client = this.getClient();
    await this.serial(async () => {
      const { state } = await this.read(), record = state.intents[state.activeId]; this.own(record, context);
      if (!record || terminal.has(record.phase) || this.preparing.has(record.id) || this.jobs.has(`${record.id}:network`) || this.jobs.has(`${record.id}:cancel`)) return;
      if (!record.submitted) { await this.change(state => { state.intents[record.id].phase = 'interrupted'; }); return; }
      if (client.storeId !== record.storeId) {
        await this.change(state => { state.intents[record.id].phase = 'interrupted'; state.intents[record.id].unconfirmedAuthentication ||= record.kind === 'resume'; }); return;
      }
      const approving = allowApproval && !record.cancelRequested && record.kind === 'login' && record.instanceId === client.instanceId && ['pending', 'scanned'].includes(record.native?.phase) && record.phase !== 'unknown';
      if (approving) await this.change(state => { state.intents[record.id].unconfirmedAuthentication = true; });
      context.signal.throwIfAborted();
      this.launch(record, client, 'network', approving ? 'poll' : 'query', () => approving ? client.pollLogin(record.id)
        : record.kind === 'login' ? client.loginOperation(record.id) : client.resumeOperation(record.id));
    });
    return this.present(context);
  }
  async cancel(context, operationId) {
    await this.assertOwner(context); this.live(); const client = this.getClient();
    await this.serial(async () => {
      const { state } = await this.read(), previous = state.intents[state.activeId]; this.own(previous, context);
      if (!previous || previous.id !== operationId) throw Error('认证操作已变化，请核对原记录');
      if (!previous || terminal.has(previous.phase) || this.jobs.has(`${previous.id}:cancel`)) return;
      const record = await this.change(state => {
        const record = state.intents[previous.id]; record.cancelRequested = true;
        record.phase = !record.submitted ? 'cancelled' : 'cancel_requested'; record.updatedAt = this.now(); return record;
      });
      this.qrs.delete(record.id);
      if (!record.submitted || client.storeId !== record.storeId) return;
      context.signal.throwIfAborted();
      this.launch(record, client, 'cancel', 'cancel', () => record.kind === 'login' ? client.cancelLogin(record.id) : client.cancelResume(record.id));
    });
    return this.present(context, operationId);
  }
  async drain() { while (this.jobs.size) await Promise.all([...this.jobs.values()]); }
  deactivate() { this.closed = true; this.qrs.clear(); }
}
