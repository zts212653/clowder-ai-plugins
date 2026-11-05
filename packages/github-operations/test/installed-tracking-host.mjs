import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** Complete packed GitHub factory, installed SDK, native Host worker/facades and owned Redis.
 * Provider snapshots and message/wake receiving are controlled; no model or GitHub network is invoked. */
export async function installedTrackingHost(t, { hostRoot, artifact, redisFixture, held = false }) {
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
const module=createGitHubPluginModule({now:()=>clock,createProvider:context=>({selfLogin:()=> 'owner',
  read:async(target,_signal,cursor)=>{ context.log('info','fixture-provider-read',{kind:target.kind,number:target.number});
    const mode=await context.config.get('fixtureScenario');
    const id=mode==='event' ? 11:mode?.startsWith('event:')?Number(mode.slice(6)):0;
    return {state:'open',headSha:'a'.repeat(40),ci:'pending',commentsComplete:true,reviews:[],
      trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'contributor'},
      comments:id>(cursor?.conversation??0)?[{id,author:'contributor',body:'isolated event',commentType:'conversation'}]:[]};
  }}),createCommunityProvider:()=>({selfLogin:()=> 'owner',listOpen:async()=>[],repoComments:async()=>[],state:async()=>null})});
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
