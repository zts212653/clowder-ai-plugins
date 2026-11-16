import { DelegationRuntime } from '../src/runtime.mjs';
import { targetQuery, searchTargets } from '../src/target-search.mjs';

export async function previewFixture() {
  const data = new Map(); let connected = false, credentials = false, generation = 0, catalogReads = 0, reminderReads = 0, staleActivation = true;
  let loginCount = 0, resumeCount = 0, repairCount = 0, lanCount = 0, caughtUp = false; const messages = new Map(), auth = new Map();
  const stream = () => ({ sourceRef: 'preview-stream', resetEpoch: 0, eventCursor: '0', caughtUp });
  const loginResult = id => ({ operation: structuredClone(auth.get(id)), qr: auth.get(id)?.phase === 'pending' ? { pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', expiresAt: Date.now() / 1000 + 300 } : null });
  let grant;
  const canonical = new Map(), runtimeModel = { clientId: '隔离测试', model: '模拟模型' };
  const host = { pluginInstanceId: 'isolated-preview', dataPath: '隔离验收的内存数据，不写用户微信目录',
    storage: {
      get: async key => structuredClone(data.get(key)),
      compareAndSet: async (key, expected, value) => { const old = data.get(key); if ((old?.revision ?? null) !== expected) return { applied: false };
        const row = { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }; data.set(key, row); return { applied: true, revision: row.revision }; },
    },
    members: { list: async () => [{ catId: 'review-cat', displayName: '验收猫（模拟）', available: true, defaultModel: '隔离模拟模型' }, { catId: 'review-cat-unavailable', displayName: '模型不可用的猫（模拟）', available: true }] },
    threads: { list: async ({ limit }) => {
      if (limit > 50) throw Error('limit must be an integer in 1..50');
      if (++reminderReads === 1) throw Error('模拟提醒列表暂不可用');
      return [{ id: 'preview-owner-thread', title: '验收提醒（模拟）' }];
    }, get: async id => ({ id, title: '验收提醒（模拟）' }) },
    messaging: { get: async id => canonical.get(id) ?? null, send: async () => ({ messageId: 'fixture-notification' }), subscribe: async () => {}, unsubscribe: async () => {} },
    memberSessions: {
      describe: async ({ catId }) => ({ available: catId !== 'review-cat-unavailable', runtime: runtimeModel, accounts: [] }),
      ensureThread: async () => ({ threadId: 'preview-isolated' }),
      prepare: async ({ catId }) => {
        grant = { sessionId: 'preview-session', generation: (grant?.generation ?? 0) + 1, consumedCursor: 0,
          threadId: 'preview-isolated', catId, ownerUserId: 'preview-owner', revoked: false, runtime: runtimeModel };
        return structuredClone(grant);
      },
      get: async () => structuredClone(grant),
      execute: async ({ executionId }) => {
        const id = `canonical:${executionId}`;
        canonical.set(id, { id, threadId: grant.threadId, userId: grant.ownerUserId, catId: grant.catId,
          content: JSON.stringify({ kind: 'message', text: '大家周末想读哪一本书？（隔离验收模拟，未发往微信）\n\n[验收猫/模拟模型🐾]' }) + '\n\n[验收猫/模拟模型🐾]' });
        return { executionId, phase: 'succeeded', responseMessageId: id };
      },
      getExecution: async () => null,
      revoke: async () => { if (grant) grant.revoked = true; },
    },
  };
  const client = {
    storeId: 'preview-store', instanceId: 'preview-server',
    identity: async () => ({ serverId: 'preview-server', nativeStoreId: 'preview-store', accountId: 'clowder', accountGeneration: generation,
      accountIdentity: credentials ? '模拟微信账号' : null, connected, credentialsAvailable: credentials, stream: credentials ? stream() : null }),
    startLogin: async id => { loginCount++; auth.set(id, { id, generation: loginCount, accountGeneration: 0, accountIdentity: null,
      phase: 'pending', startedAtMs: Date.now(), updatedAtMs: Date.now(), authenticationMayHaveOccurred: false, lanApprovalRequested: false, lanDeadlineAtMs: null }); return loginResult(id); },
    pollLogin: async id => {
      if (loginCount > 1 && auth.get(id).phase === 'pending') auth.get(id).phase = 'lan_awaiting_consent';
      else if (auth.get(id).phase === 'lan_verifying') { connected = credentials = true; generation = 1; caughtUp = false;
        Object.assign(auth.get(id), { phase: 'succeeded', accountGeneration: generation, accountIdentity: '模拟微信账号', updatedAtMs: Date.now(), authenticationMayHaveOccurred: true }); }
      return loginResult(id);
    },
    allowLoginLan: async id => { const record = auth.get(id); if (!record.lanApprovalRequested) { lanCount++; Object.assign(record, { phase: 'lan_verifying', lanApprovalRequested: true, lanDeadlineAtMs: Date.now() + 120000 }); } return loginResult(id); },
    loginOperation: async id => loginResult(id),
    cancelLogin: async id => { auth.get(id).phase = 'cancelled'; return loginResult(id); },
    resume: async id => { resumeCount++; const sourceGeneration = generation; generation++; connected = true; caughtUp = false;
      const record = { id, sourceGeneration, accountGeneration: generation, accountIdentity: '模拟微信账号', phase: 'succeeded',
        startedAtMs: Date.now(), updatedAtMs: Date.now(), authenticationMayHaveOccurred: true }; auth.set(id, record); return structuredClone(record); },
    resumeOperation: async id => structuredClone(auth.get(id)),
    cancelResume: async id => { auth.get(id).phase = 'cancelled'; return structuredClone(auth.get(id)); },
    pull: async () => { caughtUp = true; return { accountGeneration: generation, checkpoint: 1, eventCursor: '0', more: false, retainedUnprojected: 0, reset: false, stream: stream() }; },
    events: async (_account, after) => ({ items: [], nextCursor: after, more: false }),
    authorize: async (_account, _identity, destination) => ({ lease: { accountGeneration: generation, conversationGeneration: 1, destination }, stream: stream() }),
    pause: async () => ({ paused: true }),
    refreshTargets: () => { catalogReads = 0; },
    targets: async (_account, cursor = '', options = {}) => {
      if (!options.limit && staleActivation) { staleActivation = false; return { items: [], pending: true, nextCursor: null }; }
      if (++catalogReads === 1) return { items: [], pending: true, nextCursor: null };
      const all = [{ id: 'preview-friend', accountId: 'clowder', displayName: '测试好友（模拟）', kind: 'direct' },
        ...Array.from({ length: 54 }, (_, i) => ({ id: `fixture-friend-${i}`, accountId: 'clowder', displayName: `模拟好友 ${i}`, kind: 'direct' })),
        { id: 'preview-room@chatroom', accountId: 'clowder', displayName: '周末读书群（模拟）', kind: 'group' },
        ...Array.from({ length: 44 }, (_, i) => ({ id: `fixture-group-${i}@chatroom`, accountId: 'clowder', displayName: `模拟群 ${i}`, kind: 'group' }))];
      const search = targetQuery(options), matches = searchTargets(all, search), offset = cursor ? Number(cursor) : 0;
      const matched = searchTargets(all, { ...search, kind: 'all' });
      const counts = { direct: matched.filter(item => item.kind === 'direct').length, group: matched.filter(item => item.kind === 'group').length };
      const items = matches.slice(offset, offset + search.limit), next = offset + items.length;
      return { items, counts, total: matches.length, pending: false, nextCursor: next < matches.length ? String(next) : null };
    },
    prepare: async () => {}, submit: async run => { messages.set(run.id, run); return { sendId: run.id, state: 'needs_review' }; },
    inspect: async run => ({ sendId: run.sendId ?? run.id, state: 'needs_review' }),
    cancel: async run => ({ sendId: run.sendId ?? run.id, state: 'needs_review' }),
    disconnect: async () => { connected = credentials = caughtUp = false; return { disconnected: true }; },
  };
  const supervisor = { client: null, prepare: async () => { supervisor.client = client; return client; }, stopOwned: async current => { if (supervisor.client === current) supervisor.client = null; }, stop: async () => { supervisor.client = null; } };
  supervisor.reauthorize = async () => { repairCount++; await supervisor.stop(); connected = caughtUp = false; return { state: 'verified' }; };
  const runtime = await DelegationRuntime.open(host, { supervisor });
  return { runtime, owner: { kind: 'owner-http-request', userId: 'preview-owner', pluginInstanceId: host.pluginInstanceId, operation: 'write',
    requestIdentity: { requestId: 'preview-request' }, signal: new AbortController().signal, assertCurrent: async () => {} }, messages,
    offline: async () => { connected = caughtUp = false; await runtime.cycle(); }, counts: () => ({ loginCount, resumeCount, repairCount, lanCount }) };
}
