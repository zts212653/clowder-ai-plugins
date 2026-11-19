import { randomUUID } from 'node:crypto';
const KEY = 'wechat-keychain-repairs.v1';
const active = new Set(['preparing', 'requesting']);
const outcomes = new Set(['verified', 'initialized', 'already_initialized', 'key_missing', 'access_denied', 'cancelled', 'interaction_unavailable', 'authorization_not_persistent', 'busy', 'key_unavailable', 'invalid_state']);

/** Intent history only; credentials and system passwords never enter Host. */
export class KeychainFlow {
  constructor({ storage, assertOwner, beforeStart, execute, cancel }) {
    Object.assign(this, { storage, assertOwner, beforeStart, execute, cancelProcess: cancel });
    this.queue = Promise.resolve(); this.closed = false; this.pendingId = null;
  }
  live() { if (this.closed) throw Error('keychain operation expired'); }
  serial(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async read() {
    this.live(); const row = await this.storage.get(KEY); this.live();
    const state = row?.value ?? { schema: 1, records: {}, latest: null };
    if (state.schema !== 1 || !state.records || Array.isArray(state.records) || state.latest !== null && !state.records[state.latest]) throw Error('钥匙串操作记录需要修复，原件已保留');
    return { row, state };
  }
  async change(operation) {
    const { row, state: old } = await this.read(), state = structuredClone(old), value = operation(state);
    this.live(); const result = await this.storage.compareAndSet(KEY, row?.revision ?? null, state);
    if (!result.applied) throw Error('钥匙串操作记录已变化，请刷新核对');
    return structuredClone(value);
  }
  projection(record) {
    if (!record) return { state: 'idle' };
    return { operationId: record.id, kind: record.kind, state: active.has(record.phase) && this.pendingId !== record.id ? 'unknown' : record.phase,
      cancelRequested: record.cancelRequested, systemAuthorizationMayHaveOccurred: record.submitted };
  }
  async status() { const { state } = await this.read(); return this.projection(state.records[state.latest]); }
  async begin(context, kind = 'reauthorize') {
    if (!['reauthorize', 'recover-initialization'].includes(kind)) throw Error('unsupported keychain intent');
    await this.assertOwner(context); this.live();
    const record = await this.serial(async () => {
      if (this.pendingId) throw Error('已有钥匙串操作正在进行，请在系统窗口确认或取消');
      const value = { id: randomUUID(), kind, ownerUserId: context.userId, phase: 'preparing', submitted: false, cancelRequested: false, createdAt: Date.now() };
      await this.change(state => { state.records[value.id] = value; state.latest = value.id; });
      this.pendingId = value.id; return value;
    });
    try {
      await this.beforeStart(context); await this.assertOwner(context);
      const submitted = await this.serial(async () => {
        const { state } = await this.read(), current = state.records[record.id];
        if (current.cancelRequested) return null;
        context.signal.throwIfAborted();
        await this.change(state => { state.records[record.id].phase = 'requesting'; state.records[record.id].submitted = true; });
        context.signal.throwIfAborted();
        return { promise: this.execute(context, kind) };
      });
      if (submitted) {
        const result = await submitted.promise;
        if (!result || Object.keys(result).length !== 1 || !outcomes.has(result.state)) throw Error('invalid keychain repair response');
        await this.serial(() => this.change(state => { state.records[record.id].phase = result.state; }));
      }
    } catch {
      if (!this.closed) await this.serial(() => this.change(state => {
        const record = state.records[state.latest];
        if (active.has(record.phase) || record.phase === 'unknown') record.phase = record.submitted ? 'unknown' : 'cancelled';
      }));
    } finally { if (this.pendingId === record.id) this.pendingId = null; }
    return this.status();
  }
  async cancel(context, operationId) {
    await this.assertOwner(context); this.live();
    const stopping = await this.serial(async () => {
      const { state } = await this.read(), record = state.records[state.latest];
      if (!record || record.id !== operationId || record.ownerUserId !== context.userId) throw Error('请核对原钥匙串操作');
      if (!active.has(record.phase) && record.phase !== 'unknown') return null;
      await this.change(state => { const record = state.records[operationId]; record.cancelRequested = true; record.phase = record.submitted ? 'unknown' : 'cancelled'; });
      return { promise: this.cancelProcess() };
    });
    await stopping?.promise; return this.status();
  }
  deactivate() { this.closed = true; }
}
