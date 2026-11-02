import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeatureContextSession, type FeatureBinding, type FeatureHostAdapter } from './feature-context.js';
import * as contract from '@clowder-ai/plugin-contract';

test('author context has one storage/log shape and a required persistent-message reader', async () => {
 const seen:string[]=[];
 const adapter={getMessage:async(id:string)=>{seen.push(id);return null;}} as unknown as FeatureHostAdapter;
 const session=createFeatureContextSession(binding,adapter);
 assert.equal(Object.hasOwn(session.context,'state'),false);
 assert.equal(Object.hasOwn(session.context,'logger'),false);
 assert.equal(typeof session.context.messaging.get,'function');
 assert.equal(await session.context.messaging.get('missing'),null);
 assert.deepEqual(seen,['missing']);
 await session.revoke();
 await assert.rejects(()=>session.context.messaging.get('late'),/revoked/);
 assert.deepEqual(seen,['missing']);
});

test('Contract author exports contain no retired event-publication validators or DTO schema', async () => {
 for(const name of ['validateEventsPublishInput','validateDeclaredEventsPublishInput','validateEventsPublishResult'])
  assert.equal(Object.hasOwn(contract,name),false,name);
 const schema=JSON.parse(await readFile(new URL('../../plugin-contract/src/schemas/signal.schema.json',import.meta.url),'utf8'));
 for(const name of ['EventsPublishInput','EventsPublishResult','EventsPublishDisposition'])assert.equal(Object.hasOwn(schema.$defs,name),false,name);
 const generated=await readFile(new URL('../../plugin-contract/src/generated/contract.generated.ts',import.meta.url),'utf8');
 assert.equal(generated.includes('export type EventsPublish'),false);
});

test('optional runtimeInfo returns detached facts and stops with the feature', async () => {
 const facts={version:'revision',platform:'win32',architecture:'x64',nodeVersion:'22',projectRoot:'project',logDirectory:'logs'};
 const adapter={runtimeInfo:{get:async()=>facts}} as unknown as FeatureHostAdapter;
 const session=createFeatureContextSession(binding,adapter);
 const port=session.context.runtimeInfo;assert.ok(port);
 assert.notEqual(await port.get(),facts);
 await session.revoke();await assert.rejects(()=>port.get(),/revoked/);
});

const binding = {pluginInstanceId:'instance',featureId:'feature',packageRevision:'1',integrityEpoch:0,activationRevision:0,
  executionLease:'lease',dataPath:'/private/instance'} as FeatureBinding;

test('static declarations expose no dynamic registrars and dataPath stays instance-scoped', async () => {
  const session = createFeatureContextSession(binding, {} as FeatureHostAdapter);
  const context = session.context as unknown as Record<string, unknown>;
  for (const name of ['identity','scheduler','tools','mcp','skills','limbs','webhooks','mediaSources','services','conversationHosts','ui','contentEditors','windows','media','dataDirectory'])
    assert.equal(Object.hasOwn(context,name),false,name);
  assert.equal(context.dataPath,'/private/instance');
  await session.revoke();
  assert.throws(() => context.dataPath,/revoked/);
});

test('streams release only the reader and allow retry of the same reference', async () => {
  let released=0; const seen:string[]=[];
  const adapter = {streams:{read(reference:string) { seen.push(reference); return {async *[Symbol.asyncIterator]() {
    try { yield new Uint8Array([1]); yield new Uint8Array([2]); } finally {released++;}
  }}; }}} as unknown as FeatureHostAdapter;
  const session=createFeatureContextSession(binding,adapter);
  const streams = (session.context as unknown as {streams:{read(reference:string):AsyncIterable<Uint8Array>}}).streams;
  for await(const value of streams.read('hmr_source')) {assert.deepEqual([...value],[1]);break;}
  const result=[]; for await(const value of streams.read('hmr_source')) result.push(...value);
  assert.deepEqual(result,[1,2]);assert.equal(released,2);assert.deepEqual(seen,['hmr_source','hmr_source']);
  await session.revoke();assert.throws(()=>streams.read('hmr_source'),/revoked/);
});

import {definePlugin, type FeatureContext} from './feature-context.js';
import {definePluginModule} from './module-plugin.js';
import type {ModulePluginHostShape, ModulePluginSettingsHost} from './module-host.js';

function moduleManifest() {return {pluginId:'dev.surface.fixture',version:'1.0.0',contractVersion:'0.1.0',name:'Surface fixture',
  runtime:{transport:'builtin',entrypoint:'dist/index.js'},
  contributions:[{type:'tool',id:'read',name:'read',inputSchema:{type:'object'},action:{method:'read'}}],
  features:[{id:'main',name:'Main',resources:[],contributions:[{type:'tool',id:'read'}]}]};}

test('no refresh hook does not restart a module, while an explicit refresh updates cached resources',async()=>{
 let config='one',starts=0,stops=0;let context!:FeatureContext;
 const make=(explicit:boolean)=>definePluginModule(manifest=>definePlugin({manifest,activate:{main:async ctx=>{
  starts++;context=ctx;let cached=await ctx.config.get('token');
  return {actions:{read:()=>cached},...(explicit?{configRefresh:async()=>{cached=await ctx.config.get('token');if(cached==='invalid')throw new Error('bad configuration');}}:{}),dispose(){stops++;}};
 }}}));
 const host={pluginInstanceId:'instance',dataPath:'/isolated/instance',config:{get:async()=>config},secrets:{get:async()=>undefined},storage:{},tasks:{},threads:{},messaging:{get: async () => null,},streams:{read:async function*(){}},log(){}} as unknown as ModulePluginHostShape;
 const plain=await make(false).create(moduleManifest()).start(host);config='two';assert.equal(plain.configRefresh,undefined);assert.equal(await plain.actions.read!({}),'one');assert.equal(starts,1);assert.equal(stops,0);await plain.stop({reason:'test'});
 const explicit=await make(true).create(moduleManifest()).start(host);config='three';await explicit.configRefresh!();assert.equal(await explicit.actions.read!({}),'three');assert.equal(starts,2);assert.equal(stops,1);
 config='invalid';await assert.rejects(Promise.resolve(explicit.configRefresh!()),/bad configuration/);await assert.rejects(context.config.get('token'),/revoked/);await assert.rejects(Promise.resolve().then(()=>explicit.actions.read!({})),/revoked/);assert.equal(stops,2);await explicit.stop({reason:'test'});assert.equal(stops,2);
});

test('uninstall hooks can run with an installed disabled context and never require start',async()=>{
  const seen:string[]=[];let starts=0;
  const module=definePluginModule(manifest=>definePlugin({manifest,
    preUninstall:host=>{seen.push(host.dataPath);assert.equal(Object.hasOwn(host,'messaging'),false);},
    uninstall:async host=>{await host.storage.set('retained','checked');},
    activate:{main:()=>{starts++;return {actions:{read:()=>null}};}}}));
  const disabled={pluginInstanceId:'instance',dataPath:'/isolated/instance',config:{get:async()=>null},secrets:{get:async()=>undefined},
    storage:{set:async()=>{seen.push('uninstalled');return {revision:1};}},log(){}} as unknown as ModulePluginSettingsHost;
  const definition=module.create(moduleManifest());await definition.preUninstall!(disabled);await definition.uninstall!(disabled);
  assert.equal(starts,0);assert.deepEqual(seen,['/isolated/instance','uninstalled']);
});

import {readFile} from 'node:fs/promises';
import type {PluginModuleDefinition} from './module-plugin.js';
import type {PluginModuleActivationShape, PluginTaskHost} from './module-host.js';
const authorPorts=['pluginInstanceId','featureId','members','runtimeInfo','config','secrets','storage','tasks','threads','messaging','streams','dataPath','log'] as const satisfies readonly (keyof FeatureContext)[];
type RequiredMessageRead = undefined extends FeatureContext['messaging']['get'] ? never : true;
const requiredMessageRead: RequiredMessageRead = true;
type RequiredHostMessageRead = undefined extends ModulePluginHostShape['messaging']['get'] ? never : true;
const requiredHostMessageRead: RequiredHostMessageRead = true;
void [requiredMessageRead,requiredHostMessageRead];
const lifecycle=['settings','preStart','start','preUninstall','uninstall'] as const satisfies readonly (keyof PluginModuleDefinition)[];
const taskPorts=['get','list','create','update','bindDataController','revokeDataController'] as const satisfies readonly (keyof PluginTaskHost)[];
const noUndocumentedTask:Record<Exclude<keyof PluginTaskHost,typeof taskPorts[number]>,never>={};
void noUndocumentedTask;
const activationPorts=['streams','configRefresh','preStop','actions','stop'] as const satisfies readonly (keyof PluginModuleActivationShape)[];
// Adding a real author port requires a corresponding baseline entry in this same review.
const noUndocumentedContext:Record<Exclude<keyof FeatureContext,typeof authorPorts[number]>,never>={};
const noUndocumentedDefinition:Record<Exclude<keyof PluginModuleDefinition,typeof lifecycle[number]>,never>={};
const noUndocumentedActivation:Record<Exclude<keyof PluginModuleActivationShape,typeof activationPorts[number]>,never>={};
void [noUndocumentedContext,noUndocumentedDefinition,noUndocumentedActivation];
test('current public objects and the three-part developer baseline move together',async()=>{
 const doc=await readFile(new URL('../../../docs/plugin-development.md',import.meta.url),'utf8');
 assert.equal((doc.match(/^## \d\./gm)??[]).length,3);
 for(const entry of ['context.tasks.get(selector)','context.tasks.list(filter)','context.tasks.create(input,options?)','context.tasks.update(id,patch,conditions?)',
  'context.tasks.bindDataController(input)','context.tasks.revokeDataController(input)'])assert.equal(doc.includes(entry),true,entry);
 for(const retired of ['listByThread','listByKind','getBySubject','upsertBySubject','updateIfThreadId','setWait'])assert.equal(doc.includes('context.tasks.'+retired),false,retired);
 for(const name of [...authorPorts,...lifecycle,...activationPorts])assert.match(doc,new RegExp('\\b'+name+'\\b'),name);
 for(const retired of ['publicInvocations','sourceFacts','nativeContext.current','participantRoster','ownerThreads','events.publish','host.messaging.lifecycle','custody.canonicalize','deployment.getCatalog','frustration.getSource','browserServices.getBinding','predicateVerifiers'])assert.equal(doc.includes(retired),false,retired);
});

test('Task client exposes data and controller methods and never forwards dead execution methods', async()=>{
 const adapter={tasks:{prepareEntrusted(){throw new Error('Dead path');},dispatchEntrusted(){throw new Error('Dead path');}}} as unknown as FeatureHostAdapter;
 const session=createFeatureContextSession(binding,adapter);
 assert.equal(Object.hasOwn(session.context.tasks,'prepareEntrusted'),false);
 assert.equal(Object.hasOwn(session.context.tasks,'dispatchEntrusted'),false);
 assert.deepEqual(Object.keys(session.context.tasks).sort(),taskPorts.slice().sort());
 await session.revoke();
});

test('Contract does not expose an unused Task execution protocol alongside ordinary Task data', async () => {
 const schema = JSON.parse(await readFile(new URL('../../plugin-contract/src/schemas/manifest.schema.json', import.meta.url), 'utf8'));
 for (const name of ['PluginTaskAdmissionInput', 'PluginTaskAdmissionResult', 'PluginTaskDispatchInput', 'PluginTaskDispatchResult']) {
  assert.equal(Object.hasOwn(schema.$defs, name), false, name);
 }
 for (const name of ['capturePluginTaskAdmissionInput', 'assertPluginTaskAdmissionResult', 'assertPluginTaskDispatchInput', 'assertPluginTaskDispatchResult']) {
  assert.equal(Object.hasOwn(contract, name), false, name);
 }
});
