import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
import type { WeComBotAdapter } from './WeComBotAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

/** Mirrors the Host key allowlist in plugin-operation-routes.ts (operationResult). */
const ALLOWED_RESULT_KEYS = new Set(['render', 'data', 'label', 'targetValues', 'advance', 'activate']);
function assertOperationResultShape(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.ok(
    Object.keys(value).every((key) => ALLOWED_RESULT_KEYS.has(key)),
    `operation result contains a key outside the Host allowlist: ${Object.keys(value).join(',')}`,
  );
  assert.equal(typeof (value as { render?: unknown }).render, 'string');
  assert.ok(Object.hasOwn(value, 'data'));
}

const fixtureTargets=new WeakMap<ModulePluginHostShape,{config:Record<string,unknown>;secrets:Record<string,string|undefined>}>();
/** Model the existing Host order: persist declared targets, then explicitly refresh resources. Receipt data stays transient. */
async function startWithSavedTargets(definition:{start(host:ModulePluginHostShape):Promise<import('@clowder-ai/plugin-sdk').PluginModuleActivationShape>},host:ModulePluginHostShape) {
 const active=await definition.start(host),targets=fixtureTargets.get(host)!;
 const actions:Record<string,import('@clowder-ai/plugin-sdk').PluginActionHandler>={};
 for(const [method,handler]of Object.entries(active.actions))actions[method]=async(...args)=>{
  const result=await handler(...args);
  if(result&&typeof result==='object'&&'targetValues'in result&&result.targetValues&&typeof result.targetValues==='object'){
   for(const [key,value]of Object.entries(result.targetValues)){
    if(['appSecret','botSecret','botToken'].includes(key)){if(typeof value!=='string')throw new Error('invalid credential target');targets.secrets[key]=value;}else targets.config[key]=value;
   }
   await active.configRefresh?.();
  }
  return result;
 };
 return {...active,actions};
}

function hostWith(values: Record<string, string>): ModulePluginHostShape {
  const host:ModulePluginHostShape={pluginInstanceId:'fixture-instance',dataPath:'/isolated/fixture-instance',
    config: { get: async (key: string) => values[key] },
    secrets: { get: async (key: string) => values[key] },
    storage: fixtureStorage({} as never, [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }]),
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
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async (input: { threadId: string }) => ({ messageId: 'message-1', threadId: input.threadId }),
    },
    log() {},
  };fixtureTargets.set(host,{config:values,secrets:values});return host;
}

function recordConfig(calls:Record<string,unknown>,config:unknown){
 const rows=calls.configured??[];
 if(!Array.isArray(rows))throw new Error('Invalid fixture configuration history');
 rows.push([config]);calls.configured=rows;
}

function fakeRuntime(calls: Record<string, unknown>) {
  const runtime = {
    async start() { (calls.start as unknown[] | undefined)?.push([]); },
    async stop() { (calls.stop as unknown[] | undefined)?.push([]);(calls.disconnect as unknown[] | undefined)?.push([]); },
    async connect(config: unknown) { (calls.configured as unknown[] | undefined)?.push([config]); },
    async disconnect() { (calls.disconnect as unknown[] | undefined)?.push([]); },
    isConnected() { return calls.connected === true; },
    getConnectionState() { return calls.connected === true ? 'connected' : 'disconnected'; },
    get outbound() { throw new Error('not used in these tests'); },
  } as unknown as WeComBotConnectorRuntime<WeComBotAdapter>;
  return runtime;
}

test('manifest restores the wecom_validate operation with a validate → disconnect chain', async () => {
  const parsed = manifest as {
    configuration: Array<Record<string, unknown>>;
    test: { action: { method: string } };
  };
  const operation = parsed.configuration.find((item) => item.key === 'wecom_validate');
  assert.ok(operation, 'wecom_validate operation must be declared');
  assert.equal(operation.kind, 'operation');
  assert.equal(operation.key, 'wecom_validate');
  assert.deepEqual(operation.target, ['botId', 'botSecret']);
  assert.deepEqual(operation.actions, [
    { id: 'validate', label: '测试并连接', render: 'button', action: { method: 'wecom-bot.validate' }, next: 'disconnect' },
    { id: 'disconnect', label: '断开连接', render: 'button', action: { method: 'wecom-bot.disconnect' }, next: 'validate' },
  ]);
  assert.equal(parsed.test.action.method, 'wecom-bot.test');
  // Loaded settings validate user-pasted credentials before runtime enablement.
  const botId = parsed.configuration.find((item) => item.key === 'botId');
  const botSecret = parsed.configuration.find((item) => item.key === 'botSecret');
  assert.equal(botId?.required, true);
  assert.equal(botSecret?.required, true);
});

test('module starts healthy and idle without credentials', async () => {
  const calls: Record<string, unknown[][]> = { start: [] };
  const entrypoint = createWeComBotPluginModule(
    (options) => {
      assert.deepEqual(options.config, { botId: '', botSecret: '' });
      return fakeRuntime(calls);
    },
    async () => ({ valid: false }),
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({}));
  assert.deepEqual(Object.keys(active.actions).sort(), [
 'wecom-bot.disconnect', 'wecom-bot.outbound', 'wecom-bot.test', 'wecom-bot.validate',
  ]);
  await active.stop({reason:'test'});
  assert.equal(calls.start?.length, 1);
});

test('validate without credentials is a terminal error and never touches the provider', async () => {
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async () => { providerCalls += 1; return { valid: true }; },
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({}));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 0);
  await active.stop({reason:'test'});
});

test('validate with rejected credentials stays on the action with the provider message', async () => {
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async () => ({ valid: false, error: 'invalid botId' }),
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'bot', botSecret: 'secret' }));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'error', message: 'invalid botId' },
    advance: false,
  });
  await active.stop({reason:'test'});
});

test('validate with accepted credentials saves targets and refreshes resources and returns the target values', async () => {
  const calls: Record<string, unknown[][]> = { connect: [] };
  const entrypoint = createWeComBotPluginModule(
    options=>{recordConfig(calls,options.config);return fakeRuntime(calls);},
    async (botId: string, secret: string) => {
      assert.equal(botId, 'bot');
      assert.equal(secret, 'secret');
      return { valid: true };
    },
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: ' bot ', botSecret: ' secret ' }));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'bot', botSecret: 'secret' },
  });
  assert.deepEqual(calls.configured.at(-1), [{ botId: 'bot', botSecret: 'secret' }]);
  await active.stop({reason:'test'});
});

test('disconnect refreshes resources with cleared credentials and clears the persisted target values', async () => {
  const calls: Record<string, unknown[][]> = { disconnect: [] };
  const entrypoint = createWeComBotPluginModule(options=>{recordConfig(calls,options.config);return fakeRuntime(calls);}, async () => ({ valid: true }));
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'bot', botSecret: 'secret' }));
  const result = await active.actions['wecom-bot.disconnect']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'disconnected' },
    label: '已断开',
    targetValues: { botId: '', botSecret: '' },
  });
  assert.equal((calls.disconnect as unknown[] | undefined)?.length, 1);
  await active.stop({reason:'test'});
});

test('test action reports connected only when the provider WebSocket is live', async () => {
  const calls: Record<string, unknown> = { connected: false };
  const entrypoint = createWeComBotPluginModule(options=>{recordConfig(calls,options.config);return fakeRuntime(calls);}, async () => ({ valid: true }));
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'bot', botSecret: 'secret' }));
  assert.deepEqual(await active.actions['wecom-bot.test']?.({}), {
    ok: false,
    message: '当前状态: disconnected',
  });
  calls.connected = true;
  assert.deepEqual(await active.actions['wecom-bot.test']?.({}), { ok: true });
  await active.stop({reason:'test'});
});

test('validate prefers unsaved card input over stored values and returns them as targetValues', async () => {
  const calls: Record<string, unknown[][]> = { connect: [] };
  const entrypoint = createWeComBotPluginModule(
    options=>{recordConfig(calls,options.config);return fakeRuntime(calls);},
    async (botId: string, secret: string) => {
      assert.equal(botId, 'input-bot');
      assert.equal(secret, 'input-secret');
      return { valid: true };
    },
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  const result = await active.actions['wecom-bot.validate']?.({
    input: { botId: ' input-bot ', botSecret: ' input-secret ' },
  });
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'input-bot', botSecret: 'input-secret' },
  });
  assert.deepEqual(calls.configured.at(-1), [{ botId: 'input-bot', botSecret: 'input-secret' }]);
  await active.stop({reason:'test'});
});

test('validate reads the current saved secret when input only carries botId', async () => {
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async (botId: string, secret: string) => {
      assert.equal(botId, 'input-bot');
      assert.equal(secret, 'stored-secret');
      return { valid: true };
    },
  );
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  await active.actions['wecom-bot.validate']?.({ input: { botId: 'input-bot' } });
  await active.stop({reason:'test'});
});

test('disconnect clears saved credentials so an empty-input validate cannot silently reconnect', async () => {
  const calls: Record<string, unknown[][]> = { connect: [], disconnect: [] };
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    options=>{recordConfig(calls,options.config);return fakeRuntime(calls);},
    async (botId: string, secret: string) => {
      providerCalls += 1;
      assert.equal(botId, 'bot');
      assert.equal(secret, 'secret');
      return { valid: true };
    },
  );
  // Host stores nothing: the only credentials in play are the card input.
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({}));
  const first = await active.actions['wecom-bot.validate']?.({ input: { botId: 'bot', botSecret: 'secret' } });
  assertOperationResultShape(first);
  assert.deepEqual(first.data, { status: 'confirmed' });
  assert.equal(providerCalls, 1);
  await active.actions['wecom-bot.disconnect']?.({});
  const second = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(second);
  assert.deepEqual(second, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 1, 'provider validation must not run after disconnect');
  assert.deepEqual(calls.configured.at(-1),[{botId:'',botSecret:''}],'the latest resource configuration stays empty after disconnect');
  await active.stop({reason:'test'});
});

test('empty-input validate after disconnect must not fall back to the activation-time snapshot', async () => {
  const calls: Record<string, unknown[][]> = { connect: [], disconnect: [] };
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    options=>{recordConfig(calls,options.config);return fakeRuntime(calls);},
    async () => { providerCalls += 1; return { valid: true }; },
  );
  // Real steady state: last validate persisted credentials, so the Host
  // hands them to activate() — the snapshot still holds them after the
  // owner disconnects and Host writes '' back without restarting the plugin.
  const active = await startWithSavedTargets(entrypoint.create(manifest),hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  await active.actions['wecom-bot.validate']?.({});
  assert.equal(providerCalls, 1);
  await active.actions['wecom-bot.disconnect']?.({});
  const empty = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(empty);
  assert.deepEqual(empty, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 1, 'snapshot credentials must not reach the provider after disconnect');
  assert.deepEqual(calls.configured.at(-1),[{botId:'',botSecret:''}],'refresh does not restore snapshot credentials');
  // Fresh card input still wins and is written back as the target values.
  const fresh = await active.actions['wecom-bot.validate']?.({ input: { botId: 'new-bot', botSecret: 'new-secret' } });
  assertOperationResultShape(fresh);
  assert.deepEqual(fresh, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'new-bot', botSecret: 'new-secret' },
  });
  assert.equal(providerCalls, 2);
  assert.equal(providerCalls,2,'fresh explicit input performs a new validation');
  assert.deepEqual(calls.configured.at(-1), [{ botId: 'new-bot', botSecret: 'new-secret' }]);
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
