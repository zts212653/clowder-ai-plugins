import { randomUUID } from 'node:crypto';
import { targetQuery, searchTargets } from './target-search.mjs';

/** Refreshable external metadata only. The native service owns durable intent
 * and relationship proofs; this cache never grants permission to send. */
export class CurrentDirectory {
  constructor(client) { this.client = client; this.current = null; }
  pending() { return Boolean(this.current && !this.current.items && !this.current.problem); }
  refresh() {
    if (!this.current || this.current.items || ['failed', 'interrupted'].includes(this.current.record?.phase)) this.current = null;
    else if (!this.current.job) this.current.problem = null; // Keep an uncertain intent on its original id.
  }
  startJob(entry, operation) {
    entry.job = operation().catch(() => { entry.problem = Error('当前通讯录核验未完成；请刷新以继续原操作。'); }).finally(() => { entry.job = null; });
  }
  async load(entry) {
    const items = [], ids = new Set(); let offset = 0;
    for (let pageNumber = 0; pageNumber <= 100; pageNumber++) {
      const page = await this.client.directoryPage(entry.operationId, offset);
      const record = page.directory;
      if (record.accountGeneration !== entry.identity.accountGeneration || record.accountIdentity !== entry.identity.accountIdentity || record.verifiedCount > 10000) this.client.invalid();
      for (const target of page.items) { if (ids.has(target.id)) this.client.invalid(); ids.add(target.id); items.push({ ...target, accountId: 'clowder' }); }
      if (page.nextOffset === null) {
        if (items.length !== record.verifiedCount) this.client.invalid();
        const identity = await this.client.identity('clowder');
        if (!identity.connected || identity.accountGeneration !== entry.identity.accountGeneration || identity.accountIdentity !== entry.identity.accountIdentity) throw Error('directory identity changed');
        entry.items = items; entry.observedAt = record.observedAt; entry.record = record; return;
      }
      if (page.nextOffset <= offset || items.length > 10000) this.client.invalid(); offset = page.nextOffset;
    }
    this.client.invalid();
  }
  async page(accountId, token = '', options = {}) {
    this.client.accountId(accountId); const query = targetQuery(options);
    let paging;
    if (token) {
      if (typeof token !== 'string' || token.length > 8192) throw Error('invalid directory cursor');
      try { paging = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw Error('invalid directory cursor'); }
      if (!paging || Object.keys(paging).sort().join(',') !== 'kind,limit,offset,operationId,query' || paging.kind !== query.kind || paging.query !== query.query || paging.limit !== query.limit || !Number.isSafeInteger(paging.offset) || paging.offset < 0) throw Error('invalid directory cursor');
    }
    let entry = this.current;
    if (!paging && entry?.items && Date.now() - entry.observedAt > 300000) { this.current = null; entry = null; }
    if (!entry) {
      if (paging) throw Error('directory cursor expired');
      entry = { operationId: randomUUID(), identity: null, record: null, items: null, problem: null, job: null, nextAt: 0 }; this.current = entry;
    }
    if (paging && (!entry.items || paging.operationId !== entry.operationId)) throw Error('directory cursor expired');
    if (entry.problem) throw entry.problem;
    if (!entry.items) {
      if (!entry.job && Date.now() >= entry.nextAt) this.startJob(entry, async () => {
        if (!entry.identity) {
          const identity = await this.client.identity(accountId);
          if (!identity.connected) throw Error('微信账号尚未连接');
          entry.identity = structuredClone(identity);
        }
        entry.record = entry.record ? await this.client.directoryAdvance(entry.operationId) : await this.client.directoryStart(entry.operationId, entry.identity);
        if (entry.record.accountGeneration !== entry.identity.accountGeneration || entry.record.accountIdentity !== entry.identity.accountIdentity) this.client.invalid();
        entry.nextAt = Date.now() + entry.record.retryAfterMs;
        if (entry.record.phase === 'ready') await this.load(entry);
        else if (['failed', 'interrupted'].includes(entry.record.phase)) throw Error('directory did not finish');
      });
      return { items: [], nextCursor: null, pending: true };
    }
    const identity = await this.client.identity(accountId);
    if (!identity.connected || identity.accountGeneration !== entry.identity.accountGeneration || identity.accountIdentity !== entry.identity.accountIdentity) { this.current = null; throw Error('directory identity changed'); }
    const all = searchTargets(entry.items, { ...query, kind: 'all' }), matches = query.kind === 'all' ? all : all.filter(item => item.kind === query.kind);
    const offset = paging?.offset ?? 0;if (offset > matches.length) throw Error('invalid directory cursor');
    const items = matches.slice(offset, offset + query.limit), next = offset + items.length;
    return { items, total: matches.length, counts: { direct: all.filter(item => item.kind === 'direct').length, group: all.filter(item => item.kind === 'group').length },
      pending: false, observedAt: entry.observedAt, unverifiedCount: entry.record.unverifiedCount, groupDiscoveryIncomplete: entry.record.groupDiscoveryIncomplete,
      nextCursor: next < matches.length ? Buffer.from(JSON.stringify({ ...query, operationId: entry.operationId, offset: next })).toString('base64url') : null };
  }
}
