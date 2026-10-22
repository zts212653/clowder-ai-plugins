import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const factories = { feishu: 'createFeishuPluginModule', dingtalk: 'createDingTalkPluginModule',
  telegram: 'createTelegramPluginModule', 'wecom-agent': 'createWeComAgentPluginModule',
  'wecom-bot': 'createWeComBotPluginModule', weixin: 'createWeixinPluginModule', xiaoyi: 'createXiaoyiPluginModule' };
// The optional roots select physically extracted archives outside the checkout.
// Provider transport and Host ports remain substituted in both modes: packed
// execution proves closure, not production provider/Host installation acceptance.
const packedRoots = process.env.CLOWDER_CONNECTOR_PACKED_ROOTS === undefined
  ? undefined : JSON.parse(process.env.CLOWDER_CONNECTOR_PACKED_ROOTS);
if (packedRoots !== undefined) assert.deepEqual(Object.keys(packedRoots).sort(), Object.keys(factories).sort());
for (const [name, factoryName] of Object.entries(factories)) {
  test(`${name} ${packedRoots ? 'packed' : 'source'} entrypoint intercepts commands and preserves permission authority`, async () => {
    const packageRoot = packedRoots?.[name];
    const entry = await import(packageRoot === undefined
      ? `../packages/connector-${name}/src/plugin-entrypoint.ts`
      : pathToFileURL(join(packageRoot, 'dist/plugin-entrypoint.js')).href);
    const manifest = parse(await readFile(packageRoot === undefined
      ? new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url)
      : join(packageRoot, 'plugin.yaml'), 'utf8'));
    if (packageRoot !== undefined) {
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const sdk = JSON.parse(await readFile(join(packageRoot, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
      const source = JSON.parse(await readFile(new URL(`../packages/connector-${name}/package.json`, import.meta.url), 'utf8'));
      assert.equal(pkg.name, source.name);
      assert.equal(pkg.version, source.version); assert.equal(manifest.version, pkg.version);
      assert.equal(pkg.dependencies['@clowder-ai/plugin-sdk'], source.dependencies['@clowder-ai/plugin-sdk']);
      assert.equal(sdk.version, pkg.dependencies['@clowder-ai/plugin-sdk']);
    }
    assert.deepEqual(manifest.configuration.filter(field => /legacy_permissions|connector_permissions|permission.*Json|permissionRevision/.test(field.key)), []);
    const groupsSupported = ['feishu', 'dingtalk', 'wecom-bot'].includes(name);
    const state = new Map(); const replies = []; const sent = []; const closes = []; let inbound;
    let delayedPermissionRead;
    let historyAnswer = '真实历史回答';
    const outbound = { async sendFormattedReply(chat, envelope, metadata) { replies.push({ chat, body: envelope.body, metadata }); },
      async sendReply(chat, body) { replies.push({ chat, body }); },
      async onDeliveryBatchDone(chat, done) { closes.push({ chat, done }); } };
    const entrypoint = entry[factoryName](options => { inbound = options.host.deliver;
      return { outbound, async start() {}, async stop() {} }; });
    const summary = id => ({ id, deepLinkUrl: `https://owner.example:8443/thread/${encodeURIComponent(id)}`,
      title: 'Bound', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] });
    const threads = new Map([['bound', { ...summary('bound'), featureRefs: ['F202'] }]]);
    for (let i = 0; i < 50; i++) threads.set(`recent-${i}`, { ...summary(`recent-${i}`), lastActiveAt: 100 + i });
    threads.set('old-far', { ...summary('old-far'), title: 'Older thread 51', lastActiveAt: 0, featureRefs: ['F999'] });
    threads.set('system',summary('system'));
    state.set('thread-mappings.v1',{revision:1,value:[{key:'chat',threadId:'bound',createdAt:1},{key:'command-audit',threadId:'system',createdAt:1}]});
    const bindings={get(key){return state.get('thread-mappings.v1').value.find(row=>row.key===key)?.threadId;},has(key){return this.get(key)!==undefined;}};
    const cat = { catId: 'cat-eqdvbcxw', displayName: '砚砚', aliases: ['@sol'] };
    const host = {pluginInstanceId:'fixture-instance',
      config: { get: async key => ({ connectionMode: 'webhook', appKey: 'app', corpId: 'corp', agentId: 'agent',
        botId: 'bot', accessKey: 'access' })[key] }, secrets: { get: async () => 'secret' },
      storage: { get: async key => key === 'connector.permissions.v1' && delayedPermissionRead !== undefined
        ? delayedPermissionRead() : state.get(key), list: async () => Object.fromEntries(state),
        compareAndSet: async (key, expected, value) => {
          const current = state.get(key);
          if ((current?.revision ?? null) !== expected) return { applied: false, revision: current?.revision };
          const revision = (current?.revision ?? 0) + 1; state.set(key, { revision, value }); return { applied: true, revision };
        }, set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1;
          state.set(key, { revision, value }); return { revision }; }, delete: async key => ({ deleted: state.delete(key) }) },
      threads: {
        get: async id => threads.get(id) ?? null,
        list: async ({ limit = 50, before } = {}) => [...threads.values()]
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .filter(row => before === undefined || row.lastActiveAt < before.lastActiveAt ||
            (row.lastActiveAt === before.lastActiveAt && row.id > before.id)).slice(0, limit),
        create: async ({ title }) => { const thread = { ...summary(`new-${threads.size}`), title, lastActiveAt: 2 };
          threads.set(thread.id, thread); return thread; },
        update: async (id, patch) => { const thread = { ...threads.get(id), ...patch }; threads.set(id, thread); return thread; },
        getCats: async () => ({ participants: [{ ...cat, lastMessageAt: 1, messageCount: 1 }],
          routableNow: [cat], routableNotJoined: [], notRoutable: [] }),
        readMessages: async () => [{ id: 'owner-message', timestamp: 1, sender: { kind: 'owner' }, content: '真实历史问题' },
          { id: 'cat-message', timestamp: 2, sender: { kind: 'cat', catId: cat.catId }, content: historyAnswer }],
        addParticipants: async ({threadId}) => threads.get(threadId),
      },
      messaging: { subscribe: async () => {}, unsubscribe: async () => {}, send: async input => {
        sent.push(input); return { messageId: `m-${sent.length}`, threadId: input.threadId }; } }, log() {},
    };
    const active = await entrypoint.create(manifest).start(host);
    const input = (text, id, group = false, sender = 'admin') => ({ externalConversationId: 'chat',
      externalSenderId: sender, providerConversationId: 'provider-chat', providerMessageId: id, text,
      chatType: group ? 'group' : 'p2p', conversation: { type: group ? 'group' : 'direct' }, sender: { id: sender } });
    try {
      assert.deepEqual(Object.keys(active.actions).filter(key => key.startsWith('permissions.')), []);
      // Explicit Host-storage fixture for configured original group rules;
      // no import operation or second user initialization is involved.
      if (groupsSupported) await host.storage.set('connector.permissions.v1', {
        v: 1, whitelistEnabled: true, commandAdminOnly: true,
        adminConfigured: true, adminOpenIds: ['admin'], allowedGroups: [],
      });
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1); assert.match(replies[0].body, /Bound/);
      assert.ok(replies[0].body.includes(threads.get('bound').deepLinkUrl));
      assert.equal(sent.length, 1); assert.equal(sent[0].threadId, 'system'); assert.equal(sent[0].wake, undefined);
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1, 'redelivery does not repeat command');
      await inbound(input('/use F999', 'far-inventory'));
      assert.equal(bindings.get('chat'), 'old-far', 'actual entrypoint selects beyond the first 50 inventory rows');
      await inbound(input('/use F202', 'restore-far-inventory'));
      const commands = ['/commands', '/threads', '/use F202', '/thread bound explicit-thread-body', '/cats', '/status',
        '/history 1', '/focus sol', '/focus clear', '/ask sol explicit-ask-body', '/new Owner-created', '/where',
        '/unbind', '/allow-group explicit-group', '/deny-group explicit-group'];
      const seenCommands = new Set(['/where']);
      for (const [index, text] of commands.entries()) {
        const previousReplies = replies.length;
        await inbound(input(text, `command-${index}`));
        seenCommands.add(text.split(' ')[0]);
        assert.equal(replies.length, previousReplies + 1, `${text} must reply once through provider adapter`);
        if (['/use F202', '/status', '/new Owner-created', '/where'].includes(text)) {
          assert.ok(replies.at(-1).body.includes(threads.get(bindings.get('chat')).deepLinkUrl),
            `${text} uses the actual Host summary navigation field`);
        }
        if (text === '/focus sol') assert.deepEqual(threads.get('bound').preferredCats, [cat.catId]);
        if (text === '/focus clear') assert.deepEqual(threads.get('bound').preferredCats, []);
        if (text === '/history 1') assert.match(replies.at(-1).body, /真实历史问题/);
        if (text === '/where') assert.match(replies.at(-1).body, /Owner-created/);
        if (text === '/unbind') assert.equal(bindings.has('chat'), false);
        if (groupsSupported && text === '/allow-group explicit-group') assert.equal(state.get('connector.permissions.v1').value.allowedGroups[0].externalChatId, 'explicit-group');
        if (groupsSupported && text === '/deny-group explicit-group') assert.deepEqual(state.get('connector.permissions.v1').value.allowedGroups, []);
      }
      await inbound(input('/use F202', 'history-link-binding'));
      historyAnswer = '真实历史回答'.repeat(6000);
      await inbound(input('/history 1', 'truncated-history-link'));
      assert.ok(replies.at(-1).body.includes(threads.get('bound').deepLinkUrl));
      assert.match(replies.at(-1).body, /内容已精简/);
      historyAnswer = '真实历史回答';
      assert.equal(seenCommands.size, 14);
      const forwarded = sent.filter(send => send.payload.provenance.origin?.kind === 'external');
      assert.equal(forwarded.length, 2, 'only the two explicit bodies invoke an agent');
      assert.deepEqual(forwarded.map(send => send.payload.elements[0].payload.text), ['explicit-thread-body', 'explicit-ask-body']);
      assert.deepEqual(forwarded.map(send => send.wake), ['auto', { catId: cat.catId }]);
      assert.ok(sent.filter(send => !forwarded.includes(send)).every(send => send.threadId === 'system' && send.wake === undefined),
        'all command audit stays quiet in the system thread');
      await inbound(input('/use F202', 'restore-binding'));
      if (['feishu', 'dingtalk', 'wecom-bot'].includes(name)) {
        const beforeDenied = sent.length;
        await inbound(input('blocked ordinary', 'blocked-group', true, 'outsider'));
        assert.equal(sent.length, beforeDenied, 'unlisted group ordinary ingress is denied');
        await inbound(input('/allow-group', 'allow-group', true));
        assert.equal(state.get('connector.permissions.v1').value.allowedGroups[0].externalChatId, 'chat');
        const auditCount = sent.length;
        await inbound(input('/where', 'denied', true, 'outsider'));
        assert.equal(sent.length, auditCount, 'admin-only group command never wakes or audits');
      }
      if (name === 'xiaoyi') assert.equal(closes.length, replies.length - 2,
        'only two explicit bodies remain unsettled');
      if (groupsSupported) {
        const policy = structuredClone(state.get('connector.permissions.v1').value);
        await host.storage.set('connector.permissions.v1', { ...policy,
          allowedGroups: Array.from({ length: 5000 }, (_, i) => ({ externalChatId: `g${i}`, addedAt: i })) });
        const atCap = structuredClone(state.get('connector.permissions.v1'));
        await assert.rejects(inbound(input('/allow-group g5000', 'group-5001')), /group bound/);
        assert.deepEqual(state.get('connector.permissions.v1'), atCap);
        await inbound(input('/allow-group g0', 'cap-replacement'));
        assert.equal(state.get('connector.permissions.v1').value.allowedGroups.length, 5000);
        await host.storage.set('connector.permissions.v1', policy);
      }
      const persisted = structuredClone(state.get('connector.permissions.v1'));
      const beforeStop = sent.length;
      const repliesBeforeStop = replies.length;
      let enterRead, finishRead;
      const entered = new Promise(resolve => { enterRead = resolve; });
      const lateReceipt = new Promise(resolve => { finishRead = resolve; });
      delayedPermissionRead = () => { enterRead(); return lateReceipt; };
      const inFlight = inbound(input('/where', 'in-flight-before-stop'));
      await entered;
      await active.stop({reason:'test'});
      finishRead(persisted);
      await assert.rejects(inFlight, /revoked/i, 'late Host permission receipt cannot cross the revoked carrier');
      delayedPermissionRead = undefined;
      await assert.rejects(inbound(input('/where', 'late-after-stop')));
      assert.equal(sent.length, beforeStop, 'stopped carrier cannot deliver late command events');
      assert.equal(replies.length, repliesBeforeStop, 'in-flight command cannot reply success after stop');
      assert.deepEqual(state.get('connector.permissions.v1'), persisted, 'stop preserves owner permission state');
    } finally { await active.stop({reason:'test'}); }
  });
}
