import { DelegationRuntime } from '../src/runtime.mjs';

export async function previewFixture() {
  const data = new Map(); let connected = false; const messages = new Map();
  const host = { pluginInstanceId: 'isolated-preview', dataPath: '隔离验收的内存数据，不写用户微信目录',
    storage: {
      get: async key => structuredClone(data.get(key)),
      compareAndSet: async (key, expected, value) => { const old = data.get(key); if ((old?.revision ?? null) !== expected) return { applied: false };
        const row = { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }; data.set(key, row); return { applied: true, revision: row.revision }; },
    },
    members: { list: async () => [{ catId: 'review-cat', displayName: '验收猫（模拟）', available: true, defaultModel: '隔离模拟模型' }] },
    threads: { list: async () => [{ id: 'preview-owner-thread', title: '验收提醒（模拟）' }], get: async id => ({ id, title: '验收提醒（模拟）' }) },
    messaging: { send: async () => ({ messageId: 'fixture-notification' }), subscribe: async () => {}, unsubscribe: async () => {} },
  };
  const client = {
    json: async () => ({ items: [{ id: 'clowder' }] }),
    identity: async () => ({ serverId: 'preview-server', accountId: 'clowder', accountIdentity: connected ? '模拟微信账号' : null, connected }),
    createAccount: async () => ({}), login: async () => ({ id: 'preview-login', kind: 'login', accountId: 'clowder', state: 'succeeded' }),
    operation: async () => ({ id: 'preview-login', kind: 'login', accountId: 'clowder', state: 'succeeded' }),
    threads: async () => ({ items: [{ id: 'preview-friend', accountId: 'clowder', displayName: '测试好友（模拟）', kind: 'direct' },
      { id: 'preview-room@chatroom', accountId: 'clowder', displayName: '周末读书群（模拟）', kind: 'group' }], nextCursor: null }),
    prepare: async () => {}, submit: async run => { messages.set(run.id, run); return { sendId: run.id, state: 'needs_review' }; },
    inspect: async run => ({ sendId: run.sendId ?? run.id, state: 'needs_review' }),
    cancel: async run => ({ sendId: run.sendId ?? run.id, state: 'needs_review' }),
    disconnect: async () => { connected = false; return { disconnected: true }; },
  };
  const supervisor = { client: null, prepare: async () => { supervisor.client = client; connected = true; return client; }, stop: async () => { supervisor.client = null; } };
  const model = { available: () => true,
    describe: async () => ({ available: true, fingerprint: 'preview-model', runtime: { clientId: '隔离测试', model: '模拟模型' } }),
    prepare: async () => ({ sessionId: 'preview-session', generation: 1, consumedCursor: 0, threadId: 'preview-isolated' }),
    generate: async () => ({ kind: 'message', text: '大家周末想读哪一本书？（隔离验收模拟，未发往微信）' }) };
  const runtime = await DelegationRuntime.open(host, { supervisor, model, startTimer: false });
  return { runtime, owner: { kind: 'owner-http-request', userId: 'preview-owner', pluginInstanceId: host.pluginInstanceId, operation: 'write',
    requestIdentity: { requestId: 'preview-request' }, signal: new AbortController().signal, assertCurrent: async () => {} }, messages };
}
