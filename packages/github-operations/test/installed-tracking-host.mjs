import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** Complete packed GitHub factory, installed SDK, native Host worker/facades and owned Redis.
 * Provider snapshots and message/wake receiving are controlled; no model or GitHub network is invoked. */
export async function installedTrackingHost(t, { hostRoot, artifact, redisFixture, held = false, indexedCapabilities = true, providerSnapshot }) {
  const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
  const [{ ModulePluginRuntime }, { RedisPluginPrivateStorage, createPluginStorageHost },
    { RedisTaskStore }, { RedisMessageStore }, { ThreadStore }, { withPluginCallContext }] = await Promise.all([
    host('dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js'),
    host('dist/domains/plugin/host-surface/plugin-private-storage.js'),
    host('dist/domains/cats/services/stores/redis/RedisTaskStore.js'),
    host('dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
    host('dist/domains/cats/services/stores/ports/ThreadStore.js'),
    host('dist/domains/plugin/carrier/plugin-call-context.js'),
  ]);
  const root = await mkdtemp('/tmp/1843-installed-tracking-');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const actual = pathToFileURL(join(artifact, 'dist/index.js')).href;
  const source = `import { createGitHubPluginModule } from ${JSON.stringify(actual)};
let clock=1000;
function terminalSnapshot(mode) {
  const value=${JSON.stringify(providerSnapshot ?? null)};
  if(value && mode==='provider-open-same-second') return {state:'open',headSha:value.headSha,ci:'pending',
    observedAt:value.terminalFacts.observedAt+500,providerUpdatedAt:value.terminalFacts.closedAt,
    commentsComplete:true,reviews:[],comments:[],trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'contributor'}};
  if(value && ['provider-close-same-second','provider-old-close'].includes(mode)) return {...value,
    terminalFacts:{...value.terminalFacts,observedAt:value.terminalFacts.observedAt+(mode==='provider-old-close'?200:900)}};
  if(value && mode==='provider-open') return {state:'open',headSha:'e'.repeat(40),ci:'pending',
    observedAt:value.terminalFacts.observedAt+10000,providerUpdatedAt:new Date(value.terminalFacts.observedAt+10000).toISOString(),
    commentsComplete:true,reviews:[],comments:[],trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'contributor'}};
  if(value && mode==='provider-merged') {
    const at=value.terminalFacts.observedAt+20000,headSha='e'.repeat(40);
    const reviews=[{id:20,author:'reviewer',state:'APPROVED',commitId:headSha,submittedAt:new Date(at-1000).toISOString()}];
    return {...value,state:'merged',headSha,ci:'pass',reviews,comments:[],observedAt:at+1000,
      providerUpdatedAt:new Date(at).toISOString(),trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'contributor'},
      terminalFacts:{...value.terminalFacts,state:'merged',headSha,reviews,closedAt:new Date(at).toISOString(),
        mergedAt:new Date(at).toISOString(),mergeCommitSha:'f'.repeat(40),observedAt:at+1000,
        ci:{...value.terminalFacts.ci,headSha,observedAt:at+1000}}};
  }
  if (!value || !['terminal-fresh-same','terminal-fail','terminal-unknown'].includes(mode)) return value;
  const delta=mode==='terminal-fresh-same'?500:mode==='terminal-fail'?1000:2000;
  const facts=value.terminalFacts;
  if(mode==='terminal-fresh-same') return {...value,terminalFacts:{...facts,observedAt:facts.observedAt+delta,
    ci:{...facts.ci,observedAt:facts.ci.observedAt+delta}}};
  return {...value,terminalFacts:{...facts,observedAt:facts.observedAt+delta,ci:{...facts.ci,
    observedAt:facts.ci.observedAt+delta,status:mode==='terminal-fail'?'fail':'unknown',
    checkRollup:mode==='terminal-fail'?'present':'empty',checks:mode==='terminal-fail'?[{name:'controlled-rerun',bucket:'fail'}]:[]}}};
}
const module=createGitHubPluginModule({now:()=>clock,createProvider:context=>({selfLogin:()=> 'owner',
  read:async(target,_signal,cursor)=>{ context.log('info','fixture-provider-read',{kind:target.kind,number:target.number});
    const mode=await context.config.get('fixtureScenario');
    if(mode==='provider-error') throw new Error('isolated provider observation failed');
    if(mode==='provider-network-error') throw Object.assign(new Error('GitHub command failed'),{code:1,stderr:'Get "https://api.github.com/user": EOF'});
    const terminal=terminalSnapshot(mode); if(terminal) return terminal;
    const id=mode==='event' ? 11:mode?.startsWith('event:')?Number(mode.slice(6)):0;
    return {state:'open',headSha:'a'.repeat(40),ci:'pending',commentsComplete:true,reviews:[],
      trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'contributor'},
      comments:id>(cursor?.conversation??0)?[{id,author:'contributor',body:'isolated event',commentType:'conversation'}]:[]};
  }}),createCommunityProvider:context=>({selfLogin:()=> 'owner',listOpen:async()=>[],repoComments:async()=>[],
    state:async(_repo,kind,_number,_signal,includeFacts)=>{
      const value=terminalSnapshot(await context.config.get('fixtureScenario')); if(!value) return null;
      if(kind==='issue') { context.log('info','fixture-issue-state-read',{number:_number,state:'open'});
        return {state:'open',closedAt:null,mergedAt:null}; }
      context.log('info','fixture-terminal-state-read',{includeFacts,kind,number:_number});
      if(value.state==='open') return {state:'open',headSha:value.headSha,observedAt:value.observedAt,
        providerUpdatedAt:value.providerUpdatedAt,closedAt:null,mergedAt:null};
      return {state:'closed',closedAt:value.terminalFacts.closedAt,mergedAt:value.terminalFacts.mergedAt,
        ...(includeFacts?{terminalFacts:value.terminalFacts}:{})};
    }})});
export default {create(manifest){ const plugin=module.create(manifest);return {...plugin,async start(host){
  const active=await plugin.start(host),actions={...active.actions};
  for(const name of ['github.pr-tracking','github.issue-tracking']){const run=actions[name];
    actions[name]=async(...args)=>{clock=Number(await host.config.get('fixtureNow'));return run(...args);};}
  return {...active,actions};
}};}};`;
  await writeFile(join(root, 'dist/plugin.js'), source);
  const manifest = parse(await readFile(join(artifact, 'plugin.yaml'), 'utf8'));
  manifest.runtime = { ...manifest.runtime, entrypoint: 'dist/plugin.js' };
  manifest.configuration.push(...['fixtureScenario', 'fixtureNow'].map(key => ({ key, label: key, kind: 'string', required: false, hidden: true })));
  const redis = redisFixture.client(`${randomUUID()}:`), storage = new RedisPluginPrivateStorage(redis);
  const faults = { beforeIndexed: undefined, afterIndexed: undefined };
  const indexed = storage.compareAndSetIndexed.bind(storage);
  storage.compareAndSetIndexed = async (...args) => {
    await faults.beforeIndexed?.(...args);
    const receipt = await indexed(...args);
    await faults.afterIndexed?.(...args, receipt);
    return receipt;
  };
  if (!indexedCapabilities) {
    storage.compareAndSetIndexed = undefined;
    storage.readDue = undefined;
    storage.rebuildIndex = undefined;
  }
  const facade = createPluginStorageHost({ pluginId: manifest.pluginId, storage });
  const tasks = new RedisTaskStore(redis), messages = new RedisMessageStore(redis), threads = new ThreadStore();
  const thread = await threads.create('owner', 'Isolated installed acceptance');
  const mode = { scenario: 'quiet', now: 1000 };
  const events = [], sends = [];
  const record = { pluginId: manifest.pluginId, version: manifest.version, contractVersion: manifest.contractVersion,
    manifest, packageDigest: `sha512-${createHash('sha512').update(source).digest('base64')}`,
    signalSchemas: {}, packageState: 'installed', verifiedAt: 1, updatedAt: 1 };
  const service = {
    async ensureThreadHandle(input) { events.push({ message: 'fixture-thread-handle' }); return { handleId: input.threadId }; },
    async sendFromHost(_principal, draft, options) {
      events.push({ message: 'fixture-send-entered' });
      let previous, message;
      try {
        previous = await messages.getByIdempotencyKey('owner', thread.id, draft.idempotencyKey);
        message = previous ?? await messages.append({ userId: 'owner', threadId: thread.id,
          from: { kind: 'external', connectorId: options.source.connector },
          content: JSON.stringify(draft.payload), mentions: [], timestamp: mode.now,
          idempotencyKey: draft.idempotencyKey, source: options.source });
      } catch (error) { events.push({ message: 'fixture-message-error', fields: { message: error.message, stack: error.stack } }); throw error; }
      sends.push({ idempotencyKey: draft.idempotencyKey, messageId: message.id, wake: options.wake, deduplicated: !!previous });
      return { messageId: message.id, threadId: thread.id, idempotencyKey: draft.idempotencyKey };
    },
  };
  const runtime = new ModulePluginRuntime({
    packages: { resolveInstalledPackage: async () => ({ rootDir: root, manifest, verifyIntegrity: async () => {
      assert.equal(await readFile(join(root, 'dist/plugin.js'), 'utf8'), source);
    }, release: async () => {} }) },
    storage, taskStore: tasks, taskOwnerUserId: 'owner', taskThreadStore: threads,
    threads: { threadStore: threads, ownerUserId: 'owner', projectPath: root,
      threadDeepLinkUrl: id => `http://isolated.invalid/threads/${id}` },
    messaging: { service, threadStore: threads, ownerUserId: 'owner', messageStore: messages,
      delivery: { register: async () => {}, unregister: async () => {} } },
    configuration: { readSecret: async () => undefined, readConfig: async (_instance, key) =>
      key === 'recoveryMode' ? held ? 'import-only' : undefined : key === 'fixtureScenario' ? mode.scenario :
        key === 'fixtureNow' ? String(mode.now) : undefined },
    dataDirectoryParent: join(root, 'data'), log: (_level, message, fields) => events.push({ message, fields }),
  });
  const call = (method, input = {}) => withPluginCallContext('instance', { userId: 'owner', catId: 'codex61-sol',
    threadId: thread.id, invocationId: 'isolated-complete-action', ownerAuthProvenance: 'user_message',
    assertCurrent: async () => {} }, () => runtime.invoke('instance', method, input));
  t.after(async () => { await runtime.stop('instance', 'isolated-acceptance-complete');
    console.log(`retained complete-action fixture: ${root}`); });
  return { runtime, record, manifest, redis, storage, facade, faults, tasks, messages, threads, thread, mode, events, sends, call,
    providerCalls: () => events.filter(event => event.message === 'fixture-provider-read').length };
}
