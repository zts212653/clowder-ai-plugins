import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
import type { WeComBotHostInboundMessage } from './runtime.js';
import type { WeComBotAdapter } from './WeComBotAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;
// Existing owner-configured policy in the Host fixture, never an activation default.
const configuredPermissions = { revision: 1, value: { v: 1, whitelistEnabled: false, commandAdminOnly: false,
  adminConfigured: true, adminOpenIds: [], allowedGroups: [] } };
const delivery = {kind:'message' as const,
  deliveryId: 'delivery-1',
  threadId: 'thread-1',
  presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  envelope: {
    messageId: 'message-1', revision: 1, threadId: 'thread-1',
    actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
    payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
  },
};

function host(sent: unknown[] = []): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => 'bot' },
    secrets: { get: async () => 'secret' },
    storage: fixtureStorage({
      get: async key => key === 'connector.permissions.v1' ? configuredPermissions : state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      }, delete: async key => ({ deleted: state.delete(key) }),
    }, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]),
    tasks: {} as never,
    streams:{read:async function*(){}},
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    messaging: {get: async () => null, subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => { sent.push(input); return { messageId: 'message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const }; } },
    log() {},
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('provider media locator stays in private state while ingress emits only pmr', async () => {
  const sent: unknown[] = [];
  let inbound!: (message: WeComBotHostInboundMessage) => Promise<void>;
  let connected = true;
  let providerDownloads = 0;
  const outbound = {
    async downloadMedia() { providerDownloads += 1; return { buffer: Buffer.from('bytes') }; },
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    inbound = options.host.deliver;
    return {
      get outbound() {
        if (!connected) throw new Error('WeCom bot connector is not configured');
        return outbound;
      },
      async start() {}, async stop() {}, async disconnect() { connected = false; },
      isConnected() { return connected; },
      getConnectionState() { return connected ? 'connected' : 'disconnected'; },
    } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const active = await entrypoint.create(manifest).start(host(sent));
  await inbound({
    externalConversationId: 'chat-1', providerMessageId: 'provider-1', text: 'voice',
    sender: { id: 'user-1' }, conversation: { type: 'direct' },
    attachments: [{ type: 'audio', platformKey: 'https://private.example/voice|aeskey=secret' }],
  });
  const serialized = JSON.stringify(sent[0]);
  assert.match(serialized, /"reference":"pmr_wecom-bot_/u);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('aeskey'), false);
  const reference = ((sent[0] as { payload: { elements: Array<{ kind: string; payload: { reference?: string } }> } })
    .payload.elements.find(element => element.kind === 'media_ref')?.payload.reference);
  assert.equal(typeof reference, 'string');
  await active.actions['wecom-bot.disconnect']?.({});
  await active.stop({reason:'disabled'});
  await assert.rejects(async()=>{for await(const _chunk of active.streams!.read(reference!)){}},/revoked/);
  assert.equal(providerDownloads, 0, 'a stopped module must not download provider media');
  await active.stop({reason:'test'});
});

test('module exposes the declared outbound action and disposes the runtime once', async () => {
  const sent: unknown[] = [];
  let starts = 0;
  let stops = 0;
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { sent.push(args); },
    async sendMedia() {},
    async sendReply() {},
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    assert.deepEqual(options.config, { botId: 'bot', botSecret: 'secret' });
    return {
      outbound,
      async start() { starts += 1; },
      async stop() { stops += 1; },
    } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const active = await entrypoint.create(manifest).start(host());
  assert.equal(typeof active.actions['wecom-bot.outbound'], 'function');
  await active.actions['wecom-bot.outbound']?.(delivery);
  await Promise.all([active.stop({reason:'test'}), active.stop({reason:'test'})]);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as unknown[])[0], 'chat-1');
});

test('delivery without presentation is rejected by the module presentation guard', async () => {
  const entrypoint = createWeComBotPluginModule(() => ({
    outbound: { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} },
    async start() {}, async stop() {},
  }) as unknown as WeComBotConnectorRuntime<WeComBotAdapter>);
  const active = await entrypoint.create(manifest).start(host());
  const missingPresentation = structuredClone(delivery) as Record<string, unknown>;
  delete missingPresentation.presentation;
  await assert.rejects(
    async () => { await active.actions['wecom-bot.outbound']?.(missingPresentation); },
    (error: unknown) => error instanceof Error
      && error.name === 'PresentationDeliveryInputError'
      && /presentation/i.test(error.message),
  );
  await active.stop({reason:'test'});
});

test('lifecycle action edits the WeCom stream once for blocked and finalizes it on settled', async () => {
  const calls: unknown[][] = [];
  const outbound = {
    async sendPlaceholder(...args: unknown[]) { calls.push(['placeholder', ...args]); return 'stream-1'; },
    async editMessage(...args: unknown[]) { calls.push(['edit', ...args]); return true; },
    async sendReply(...args: unknown[]) { calls.push(['reply', ...args]); },
    async deleteMessage(...args: unknown[]) { calls.push(['delete', ...args]); },
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule(() => ({
    outbound, async start() {}, async stop() {},
  }) as WeComBotConnectorRuntime<WeComBotAdapter>);
  const active = await entrypoint.create(manifest).start(host());
  const action = active.actions['wecom-bot.outbound']!;
  await action({kind:'execution_status' as const,
    executionId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  });
  await action({kind:'execution_status' as const,
    executionId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user',
  });
  await assert.rejects(
    Promise.resolve(action({kind:'execution_status' as const, executionId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'blocked', reason: 'again' })),
    (error: unknown) => (error as { code?: string }).code === 'EXECUTION_OUT_OF_ORDER',
  );
  await action({kind:'execution_status' as const,
    executionId: 'life-1', deliveryId: 'delivery-4', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed',
  });
  assert.deepEqual(calls, [
    ['placeholder', 'chat-1', '【砚砚🐱】🤔 思考中...'],
    ['edit', 'chat-1', 'stream-1', '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。', { bypassThrottle: true }],
    ['delete', 'stream-1'],
  ]);
  await active.stop({reason:'test'});
});

function richDelivery() {
  return {kind:'message' as const,
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [
        { elementId: 't1', kind: 'text', payload: { text: '正文' } },
        { elementId: 'u1', kind: 'media_unavailable', payload: { type: 'image', fileName: 'diagram.png', reason: 'source_expired' } },
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.amr' } },
        { elementId: 'm2', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_denied' } },
        { elementId: 'm3', kind: 'media_ref', payload: { type: 'file', reference: 'legacy-provider-key' } },
        { elementId: 'm4', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
        { elementId: 'm5', kind: 'media_ref', payload: { type: 'file', reference: 'hmr_large', fileName: 'large.bin' } },
        { elementId: 'w1', kind: 'media_warning', payload: { mediaElementId: 'm1', stage: 'transcription', reason: 'processing_failed' } },
        { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
        { elementId: 'r2', kind: 'rich_block', payload: { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] } },
      ] },
    },
  };
}

test('rich blocks and typed media notices route to sendRichMessage instead of sendFormattedReply', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.formatted', value: args }); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      if (payload.fileName === 'large.bin') throw new RangeError('provider limit');
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      calls.push({ operation: 'provider.media', value: [chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName] });
    },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.notice', value: args }); },
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeComBotConnectorRuntime<WeComBotAdapter>);
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => 'bot' }, secrets: { get: async () => 'secret' },
    storage: fixtureStorage({ get: async () => configuredPermissions } as never, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]), tasks: {} as never,
    streams:{read:async function*(reference:string){if(reference==='hmr_denied')throw Object.assign(new Error('denied'),{name:'MEDIA_ACCESS_DENIED'});yield Buffer.from('voice-');yield Buffer.from('bytes');}},
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    messaging: {get: async () => null,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await active.actions['wecom-bot.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：voice.amr（转写处理失败）', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'Cat', undefined] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.amr'] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（读取或上传失败）', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（旧引用无法读取）', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 视频附件暂不支持发送', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体过大，超过企业微信发送上限', undefined] },
  ]);
  calls.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['wecom-bot.outbound']?.(typedOnly);
  assert.deepEqual(calls.map(call => call.operation), ['provider.formatted']);
  await active.stop({reason:'test'});
});

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: WeComBotHostInboundMessage) => Promise<void>;
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {}, async sendReply() {},
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => 'bot' }, secrets: { get: async () => 'secret' },
    storage: fixtureStorage({
      get: async key => key === 'connector.permissions.v1' ? configuredPermissions : state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    }, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]),
    tasks: {} as never,
    streams:{read:async function*(){}},
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    messaging: {get: async () => null,
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  const sender = { id: 'sender-1', name: 'Sender' };
  await inbound({
    externalConversationId: 'chat-1',
    providerMessageId: 'provider-1',
    text: 'inbound',
    sender,
    conversation: { type: 'group' },
  });
  const matched = structuredClone(delivery) as typeof delivery & { envelope: { replyTo?: string } };
  matched.envelope.replyTo = 'host-message-1';
  await active.actions['wecom-bot.outbound']?.(matched);
  const sent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(sent[0], 'chat-1');
  assert.equal((sent[1] as { header: string }).header, 'Cat');
  assert.deepEqual(sent[2], { replyToSender: { id: 'sender-1', name: 'Sender' } });
  calls.length = 0;
  const missed = structuredClone(delivery) as typeof delivery & { envelope: { replyTo?: string } };
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  await active.actions['wecom-bot.outbound']?.(missed);
  const missedSent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(missedSent[2], undefined);
  await active.stop({reason:'test'});
});

function fixtureStorage(base: Partial<import('@clowder-ai/plugin-sdk').PluginStorageHost>, mappings: readonly {key:string;threadId:string;createdAt?:number}[]) {
 const entries=new Map<string,{revision:number;value:unknown}>();
 entries.set('thread-mappings.v1',{revision:1,value:mappings.map(row=>({...row,createdAt:row.createdAt??1}))});
 return {
  async get(key:string){return key==='thread-mappings.v1'?entries.get(key):(await base.get?.(key)??entries.get(key));},
  async list(){return {...await base.list?.(),...Object.fromEntries(entries)};},
  async set(key:string,value:unknown){const original=await base.set?.(key,value);const revision=original?.revision??(entries.get(key)?.revision??0)+1;if(key==='thread-mappings.v1'||!await base.get?.(key))entries.set(key,{revision,value});else entries.delete(key);return {revision};},
  async compareAndSet(key:string,expected:number|null,value:unknown){
   if(key!=='thread-mappings.v1'&&base.compareAndSet)return base.compareAndSet(key,expected,value);
   const current=await this.get(key);if((current?.revision??null)!==expected)return {applied:false,revision:current?.revision};
   return {applied:true,...await this.set(key,value)};
  },
  async delete(key:string,expected?:number){const current=await this.get(key);if(expected!==undefined&&current?.revision!==expected)return {deleted:false,revision:current?.revision};entries.delete(key);return await base.delete?.(key,expected)??{deleted:!!current};},
 };
}
