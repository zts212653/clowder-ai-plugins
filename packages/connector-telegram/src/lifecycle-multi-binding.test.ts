import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

// The Host allows rebinding different external chats onto the same thread
// (see Host ConnectorCommandLayer /use and /thread flows), so one threadId
// can back several provider bindings. The lifecycle action must fan every
// outbound effect out to all of them instead of only the first match.

type StoredRecord = {
  tombstone?: boolean;
  platformMessageByKey?: Record<string, string>;
};

function harness(options?: {
  placeholderIds?: Record<string, string>;
}) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const calls: unknown[][] = [];
  const context = {
    storage: fixtureStorage({
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    }, [
        { key: 'chat-1', threadId: 'thread-1', createdAt: 1 },
        { key: 'chat-2', threadId: 'thread-1', createdAt: 2 },
      ]),
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    log() {},
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) {
      calls.push(['sendPlaceholder', ...args]);
      return options?.placeholderIds?.[args[0] as string] ?? `placeholder-${args[0]}`;
    },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  const action = createConnectorLifecycleAction(context, callbacks);
  const record = async (): Promise<StoredRecord> => ((await context.storage.get('lifecycle/life-1'))?.value ?? {}) as StoredRecord;
  return { action, calls, record };
}

function started(overrides: Record<string, unknown> = {}) {
  return {kind:'execution_status' as const,
    executionId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    ...overrides,
  };
}

// Later states must not repeat the started-only presentation block: the
// lifecycle event schema is state-specific (additionalProperties:false).
function transition(state: string, deliveryId: string) {
  return {kind:'execution_status' as const, executionId: 'life-1', deliveryId, threadId: 'thread-1', state };
}

test('started fans the placeholder out to every binding of the thread', async () => {
  const { action, calls } = harness();
  await action(started());
  assert.deepEqual(calls, [
    ['sendPlaceholder', 'chat-1', '【砚砚🐱】🤔 思考中...'],
    ['sendPlaceholder', 'chat-2', '【砚砚🐱】🤔 思考中...'],
  ]);
});

test('started records the placeholder id per binding key', async () => {
  const { action, record } = harness({
    placeholderIds: { 'chat-1': 'placeholder-a', 'chat-2': 'placeholder-b' },
  });
  await action(started());
  const stored = await record();
  assert.deepEqual(stored.platformMessageByKey, { 'chat-1': 'placeholder-a', 'chat-2': 'placeholder-b' });
});

test('catching_up edits the placeholder on every binding', async () => {
  const { action, calls } = harness({
    placeholderIds: { 'chat-1': 'placeholder-a', 'chat-2': 'placeholder-b' },
  });
  await action(started());
  calls.length = 0;
  await action(transition('catching_up', 'delivery-2'));
  assert.deepEqual(calls, [
    ['editPlaceholder', 'chat-1', 'placeholder-a', '🔄 收到新消息，正在重新整理回复…', 'catching_up', 'life-1'],
    ['editPlaceholder', 'chat-2', 'placeholder-b', '🔄 收到新消息，正在重新整理回复…', 'catching_up', 'life-1'],
  ]);
});

test('settled settles every binding with its own placeholder id', async () => {
  const { action, calls, record } = harness({
    placeholderIds: { 'chat-1': 'placeholder-a', 'chat-2': 'placeholder-b' },
  });
  await action(started());
  calls.length = 0;
  await action({ ...transition('settled', 'delivery-2'), chainDone: true, outcome: 'completed' });
  const settles = calls.filter(call => call[0] === 'settle');
  assert.equal(settles.length, 2);
  const byChat = new Map(settles.map(call => [(call[1] as { externalConversationId: string }).externalConversationId, call[1]]));
  assert.equal((byChat.get('chat-1') as { platformMessageId?: string }).platformMessageId, 'placeholder-a');
  assert.equal((byChat.get('chat-2') as { platformMessageId?: string }).platformMessageId, 'placeholder-b');
  const stored = await record();
  assert.equal(stored.tombstone, true);
  assert.deepEqual(stored.platformMessageByKey, { 'chat-1': 'placeholder-a', 'chat-2': 'placeholder-b' });
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
