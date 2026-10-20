import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

function harness(options?: {
  failSet?: (callIndex: number) => Error | undefined;
}) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const calls: unknown[][] = [];
  const warnings: unknown[][] = [];
  let setCalls = 0;
  const context = {
    storage: fixtureStorage({
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        setCalls += 1;
        const failure = options?.failSet?.(setCalls);
        if (failure !== undefined) throw failure;
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    }, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]),
    threads: {get:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
create:async({title}:{title:string})=>({id:'thread-1',title,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
list:async()=>[],
readMessages:async()=>[],
getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),
update:async(id:string)=>({id,title:id,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]}),
addParticipants:async({threadId}:{threadId:string})=>({id:threadId,title:threadId,createdAt:1,lastActiveAt:1,deepLinkUrl:"https://local/thread",preferredCats:[],featureRefs:[]})},
    log(level: string, message: string, fields?: unknown) { warnings.push([level, message, fields]); },
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return 'placeholder-1'; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls, warnings, state };
}

function started(overrides: Record<string, unknown> = {}) {
  return {kind:'execution_status' as const,
    executionId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    ...overrides,
  };
}

test('pre-write failure after the retry throws PLUGIN_INTERNAL before any platform side effect', async () => {
  const { action, calls, state } = harness({ failSet: () => new Error('storage down') });
  await assert.rejects(action(started()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'PLUGIN_INTERNAL');
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(state.size, 0);
});

test('post-write failure warns, does not throw, and a Host replay answers replay without re-sending', async () => {
  const event = started();
  const { action, calls, warnings } = harness({
    failSet: (callIndex) => (callIndex === 2 ? new Error('post-write boom') : undefined),
  });
  const first = await action(event);
  assert.deepEqual(first, { deliveryId: 'delivery-1' });
  assert.equal(calls.filter(call => call[0] === 'sendPlaceholder').length, 1);
  assert.ok(warnings.some(warning => warning[1] === 'Connector lifecycle state post-write failed'));

  const replay = await action(event);
  assert.deepEqual(replay, { deliveryId: 'delivery-1' });
  assert.equal(calls.filter(call => call[0] === 'sendPlaceholder').length, 1);
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
