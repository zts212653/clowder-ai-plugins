import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeixinPluginModule } from './plugin-entrypoint.js';
import type { WeixinAdapter } from './WeixinAdapter.js';
import type { WeixinConnectorRuntime } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function delivery() {
  return {kind:'message' as const,
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

function multiBindingHost(bindings: Array<{ key: string; threadId: string }>, warnings: unknown[][]) {
  return {pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async () => undefined }, secrets: { get: async () => 'token' },
    storage: fixtureStorage({} as never, bindings.map(binding => ({ ...binding, createdAt: 1 }))), tasks: {} as never,
    streams:{read:async function*(){}},
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    messaging: {get: async () => null, subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log(...args: unknown[]) { warnings.push(args); },
  } satisfies ModulePluginHostShape;
}

function failingOutbound(sends: unknown[][], failingChats: Set<string>) {
  return {
    async sendReply(...args: unknown[]) {
      sends.push(args);
      const chatId = args[0];
      if (typeof chatId === 'string' && failingChats.has(chatId)) throw new Error(`chat ${chatId} is down`);
    },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
}

test('multi-binding outbound delivers to the healthy chat when one binding send fails', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad']));
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host = multiBindingHost(
    [{ key: 'chat-good', threadId: 'thread-1' }, { key: 'chat-bad', threadId: 'thread-1' }],
    warnings,
  );
  const active = await entrypoint.create(manifest).start(host);
  await active.actions['weixin.outbound']?.(delivery());
  const goodSends = sends.filter(args => args[0] === 'chat-good');
  assert.equal(goodSends.length, 1, 'the healthy chat must receive exactly one delivery');
  assert.deepEqual(goodSends[0], ['chat-good', '【Cat🐱】\nhello', undefined]);
  assert.equal(sends.filter(args => args[0] === 'chat-bad').length, 1, 'the failing chat is attempted once');
  const bindingFailures = warnings.filter(args => args[0] === 'warn' && String(args[1]).includes('one binding failed'));
  assert.equal(bindingFailures.length, 1);
  assert.deepEqual(bindingFailures[0]?.[2], { externalConversationId: 'chat-bad', errorName: 'Error' });
  await active.stop({reason:'test'});
});

test('multi-binding outbound rejects only when every binding send fails', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad', 'chat-worse']));
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host = multiBindingHost(
    [{ key: 'chat-bad', threadId: 'thread-1' }, { key: 'chat-worse', threadId: 'thread-1' }],
    warnings,
  );
  const active = await entrypoint.create(manifest).start(host);
  await assert.rejects(
    async () => active.actions['weixin.outbound']?.(delivery()),
    /chat chat-bad is down/,
  );
  assert.equal(sends.length, 2, 'every binding is still attempted');
  assert.equal(warnings.filter(args => args[0] === 'warn' && String(args[1]).includes('one binding failed')).length, 2);
  await active.stop({reason:'test'});
});

test('single-binding outbound send failure still rejects the action', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad']));
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host = multiBindingHost([{ key: 'chat-bad', threadId: 'thread-1' }], warnings);
  const active = await entrypoint.create(manifest).start(host);
  await assert.rejects(
    async () => active.actions['weixin.outbound']?.(delivery()),
    /chat chat-bad is down/,
  );
  assert.equal(sends.length, 1);
  await active.stop({reason:'test'});
});

test('outbound rejects with a synthesized error when the provider throws undefined', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = {
    async sendReply(...args: unknown[]) {
      sends.push(args);
      throw undefined;
    },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeixinConnectorRuntime<WeixinAdapter>);
  const host = multiBindingHost([{ key: 'chat-bad', threadId: 'thread-1' }], warnings);
  const active = await entrypoint.create(manifest).start(host);
  await assert.rejects(
    async () => active.actions['weixin.outbound']?.(delivery()),
    /Weixin outbound delivery failed for all bindings \(provider did not report an error\)/,
  );
  assert.equal(sends.length, 1);
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
