import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeixinPluginModule } from './plugin-entrypoint.js';
import type { WeixinConnectorRuntime, WeixinHostInboundMessage } from './runtime.js';
import type { WeixinAdapter } from './WeixinAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;
// Existing owner-configured policy in the Host fixture, never an activation default.
const configuredPermissions = { revision: 1, value: { v: 1, whitelistEnabled: false, commandAdminOnly: false,
  adminConfigured: true, adminOpenIds: [], allowedGroups: [] } };

function delivery() {
  return {kind:'message' as const,
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: '小狸', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: '砚砚' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module binds Host-owned state and exposes only its declared outbound action', async () => {
  const writes: unknown[] = [];
  const replies: unknown[] = [];
  let stops = 0;
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule((options) => ({
    outbound,
    async start() {
      await options.state.save({ getUpdatesBuf: 'cursor' });
    },
    async stop() { stops += 1; },
  } as WeixinConnectorRuntime<WeixinAdapter>));
  const values: Record<string, unknown> = {
    voiceItemMode: 'minimal',
    enableUnsafeVoiceModes: false,
    captureInboundVoiceMedia: false,
  };
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async (key: string) => values[key] },
    secrets: { get: async () => 'token' },
    storage: fixtureStorage({
      get: async () => undefined, list: async () => ({}),
      set: async (key: string, value: unknown) => { writes.push([key, value]); return { revision: 1 }; },
      compareAndSet: async () => ({ applied: false }), delete: async () => ({ deleted: false }),
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
    messaging: {get: async () => null, subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await active.actions['weixin.outbound']?.(delivery());
  await active.stop({reason:'test'});
  assert.deepEqual(writes, [['provider-session', { getUpdatesBuf: 'cursor' }]]);
  assert.deepEqual(replies, [['chat-1', '【小狸🐱】\nhello', undefined]]);
  assert.equal(stops, 1);
});

test('provider media locator stays in private state while ingress emits only pmr', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const sent: unknown[] = [];
  let inbound!: (message: WeixinHostInboundMessage) => Promise<void>;
  let connected = true;
  let providerDownloads = 0;
  const outbound = {
    async downloadInboundMedia() { providerDownloads += 1; return Buffer.from('bytes'); },
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule((options) => {
    inbound = options.host.deliver;
    return {
      get outbound() {
        if (!connected) throw new Error('Weixin connector is not connected');
        return outbound;
      },
      async start() {}, async stop() {}, async disconnect() { connected = false; },
      isConnected() { return connected; },
    } as WeixinConnectorRuntime<WeixinAdapter>;
  });
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => undefined }, secrets: { get: async () => 'token' },
    storage: fixtureStorage({
      get: async key => key === 'connector.permissions.v1' ? configuredPermissions : state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      }, delete: async key => ({ deleted: state.delete(key) }),
    }, []),
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
      send: async input => { sent.push(input); return { messageId: 'message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const }; },
    },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1', externalSenderId: 'user-1', providerMessageId: 'provider-1', text: 'photo',
    attachments: [{ type: 'image', platformKey: '{"fullUrl":"https://private","aesKey":"secret"}' }],
  });
  const serialized = JSON.stringify(sent[0]);
  assert.match(serialized, /"reference":"pmr_weixin_/u);
  assert.equal(serialized.includes('https://private'), false);
  assert.equal(serialized.includes('aesKey'), false);
  const reference = ((sent[0] as { payload: { elements: Array<{ kind: string; payload: { reference?: string } }> } })
    .payload.elements.find(element => element.kind === 'media_ref')?.payload.reference);
  assert.equal(typeof reference, 'string');
  await active.actions['weixin.disconnect']?.({});
  await active.stop({reason:'disabled'});
  await assert.rejects(async()=>{for await(const _chunk of active.streams!.read(reference!)){}},/revoked/);
  assert.equal(providerDownloads, 0, 'a stopped module must not download provider media');
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.wav' } },
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

test('rich blocks and typed media notices append rendered plaintext blocks to the joined reply', async () => {
  const replies: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      if (payload.fileName === 'large.bin') throw new RangeError('provider limit');
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      replies.push([chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName]);
    },
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => undefined }, secrets: { get: async () => 'token' },
    storage: fixtureStorage({
      get: async () => undefined, list: async () => ({}),
      set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: false }), delete: async () => ({ deleted: false }),
    } as never, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]),
    tasks: {} as never,
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
  await active.actions['weixin.outbound']?.(richDelivery());
  assert.deepEqual(replies, [
    ['chat-1', '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：voice.wav（转写处理失败）\n\n📋 T\nB\n\n☑️ L\n✅ a\n☐ b', undefined],
    ['chat-1', 'audio', 'voice-bytes', 'voice.wav'],
    ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（读取或上传失败）', undefined],
    ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（旧引用无法读取）', undefined],
    ['chat-1', '【Cat🐱】\n⚠️ 视频附件暂不支持发送', undefined],
    ['chat-1', '【Cat🐱】\n⚠️ 媒体过大，超过插件的安全上限 25 MiB', undefined],
  ]);
  replies.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['weixin.outbound']?.(typedOnly);
  assert.equal(replies.length, 1);
  assert.equal((replies[0] as unknown[])[1], '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）');
  await active.stop({reason:'test'});
});

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const replies: unknown[] = [];
  let inbound!: (message: WeixinHostInboundMessage) => Promise<void>;
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as WeixinConnectorRuntime<WeixinAdapter>;
  });
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => undefined }, secrets: { get: async () => 'token' },
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
  await inbound({
    externalConversationId: 'chat-1', externalSenderId: 'user-1', providerMessageId: 'provider-1', text: 'inbound',
  });
  const matched = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  matched.envelope.replyTo = 'host-message-1';
  await active.actions['weixin.outbound']?.(matched);
  assert.equal((replies[0] as unknown[])[0], 'chat-1');
  assert.equal((replies[0] as unknown[])[1], '【小狸🐱】\nhello');
  assert.deepEqual((replies[0] as unknown[])[2], { replyToSender: { id: 'user-1' } });
  replies.length = 0;
  const missed = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  await active.actions['weixin.outbound']?.(missed);
  assert.equal((replies[0] as unknown[])[2], undefined);
  await active.stop({reason:'test'});
});

test('weixin.outbound rejects a delivery without presentation (subscription presentation v1)', async () => {
  const replies: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host: ModulePluginHostShape = {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => undefined }, secrets: { get: async () => 'token' },
    storage: fixtureStorage({
      get: async () => undefined, list: async () => ({}),
      set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: false }), delete: async () => ({ deleted: false }),
    } as never, []),
    tasks: {} as never,
    streams:{read:async function*(){}},
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    messaging: {get: async () => null, subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  const withoutPresentation = delivery() as Record<string, unknown>;
  delete withoutPresentation.presentation;
  await assert.rejects(async () => active.actions['weixin.outbound']?.(withoutPresentation), /presentation/i);
  assert.deepEqual(replies, [], 'the provider must not be reached for a rejected delivery');
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
