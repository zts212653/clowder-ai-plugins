import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pluginId = 'dev.clowder.issue-workbench';
export const grants = ['messaging.send', 'plugin.config.read', 'plugin.state.get', 'plugin.state.set',
  'schedule.register', 'thread.listMetadata', 'thread.readContent'];
const owner = 'issue-sandbox-owner';

/** Isolated composition only. No live Host auth, ports, config, or data are used. */
export async function sandboxRuntime({ root, hostRoot, archive, settings, allowArchiveUpgrade = false }) {
  assert.ok(hostRoot && archive, 'Set compiled Host root and exact plugin archive');
  hostRoot = resolve(hostRoot); archive = resolve(archive);
  const archiveIntegrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
  const originalCwd = process.cwd();
  const sourceStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' });
  const before = sourceStatus();
  const runtimePaths = ['runtime-composition.js', 'builtin-runtime/carriers/module-plugin-runtime.js',
    'host-surface/plugin-private-storage.js', 'operations/plugin-operation-routes.js', 'external-runtime/package-staging.js'];
  const digests = async () => Object.fromEntries(await Promise.all(runtimePaths.map(async p =>
    [p, createHash('sha256').update(await readFile(join(hostRoot, 'packages/api/dist/domains/plugin', p))).digest('hex')])));
  const runtimeBefore = await digests();
  process.chdir(root);
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const hostImport = p => import(pathToFileURL(join(hostRoot, 'packages/api', p)).href);
  await hostImport('test/helpers/setup-cat-registry.js');
  const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await hostImport('dist/domains/plugin/index.js');
  const { RedisMessageStore } = await hostImport('dist/domains/cats/services/stores/redis/RedisMessageStore.js');
  const { RedisThreadStore } = await hostImport('dist/domains/cats/services/stores/redis/RedisThreadStore.js');
  const { InstalledPluginOperations, pluginOperationRoutes } = await hostImport('dist/domains/plugin/operations/plugin-operation-routes.js');
  const { withPluginCallContext } = await hostImport('dist/domains/plugin/carrier/plugin-call-context.js');
  const requireHost = createRequire(join(hostRoot, 'packages/api/package.json'));
  const Fastify = requireHost('fastify'), Redis = requireHost('ioredis');
  const { catRegistry } = await import(pathToFileURL(join(hostRoot, 'packages/shared/dist/index.js')).href);
  const catId = catRegistry.getAllIds()[0];
  assert.ok(catId, 'Isolated Host template must contain a cat');
  const redisDirectory = join(root, 'redis'); await mkdir(redisDirectory, { recursive: true });
  const socketDirectory = await mkdtemp(join(tmpdir(), 'iw-socket-'));
  const socket = join(socketDirectory, 'redis.sock');
  const child = spawn(process.env.ISSUE_WORKBENCH_REDIS_BIN ?? 'redis-server',
    ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--dir', redisDirectory,
      '--appendonly', 'yes', '--appendfsync', 'always', '--save', ''], { cwd: root, stdio: 'ignore' });
  let spawnError;
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', e => { spawnError = e; resolve(); }); });
  const redis = new Redis({ path: socket, retryStrategy: count => count < 100 ? 25 : null });
  redis.on('error', () => {});
  const hosts = new Set(), clients = new Set();
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const host of hosts) await host.close();
    for (const client of clients) client.disconnect();
    redis.disconnect(); child.kill('SIGTERM'); await exited;
    const report = { hostRoot, hostHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(),
      archive, integrity: 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64'),
      hostSourceUnchanged: before === sourceStatus(), hostRuntimeUnchanged: JSON.stringify(runtimeBefore) === JSON.stringify(await digests()),
      fixtures: ['local owner session', 'seven test grants', 'cat identity and outcomes', 'GitHub CLI', 'schedule clock'],
      persistence: 'Private Redis AOF; separate databases; thread/message/plugin state TTL=0' };
    await writeFile(join(root, 'host-verification.json'), JSON.stringify(report, null, 2));
    process.chdir(originalCwd);
  };
  try { await redis.ping(); if (spawnError) throw spawnError; } catch (e) { await close(); throw e; }

  async function createHost(name) {
    const database = redis.duplicate({ db: name === 'sender' ? 1 : 2 }); clients.add(database);
    const projectRoot = join(root, name); await mkdir(projectRoot, { recursive: true });
    const messages = new RedisMessageStore(database, { ttlSeconds: 0 });
    const threads = new RedisThreadStore(database, { ttlSeconds: 0 });
    const savedThread = await database.get('sandbox-thread');
    const thread = savedThread ? await threads.get(savedThread) : await threads.create(owner, 'Issue sandbox ' + name, projectRoot);
    assert.ok(thread, 'Retained sandbox thread must remain readable');
    await database.set('sandbox-thread', thread.id);
    const wakes = [], schedules = new Map(); let mcp = null;
    const runtime = createDormantPluginRuntimeComposition({ projectRoot, redis: database, messageStore: messages, threadStore: threads,
      threadOwnerUserId: owner, threadDeepLinkUrl: () => '/',
      threadProjections: { cats: { getAllCatIds: () => [catId], getCatDisplayName: () => '模拟研判猫',
        getCatAliases: () => ['sandbox-analyst'], isCatAvailable: () => true, getRegisteredServices: () => new Map([[catId, {}]]) } },
      invokeTrigger: { trigger: async (...input) => {
        if (settings.catMode === 'failure' && name === 'sender') throw new Error('模拟猫连接失败：切换为成功后重试，原请求保留');
        wakes.push(input); return 'dispatched';
      } },
      taskRunner: { registerPostStart: task => schedules.set(task.id, task), unregister: id => schedules.delete(id) },
      mcpConfigIO: { readConfig: async () => mcp, writeAndRegenCli: async value => { mcp = value; }, withLock: fn => fn() },
    });
    const composition = createPluginManagerRuntimeComposition({ runtime,
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
      catalogManifests: [], localGrantPolicy: () => grants });
    const manager = composition.manager;
    const operations = new InstalledPluginOperations({ inventory: runtime.inventoryStore,
      configuration: composition.configuration, invocation: runtime.supervisor, settingsInvocation: runtime.settingsInvocation });
    const app = Fastify();
    app.addHook('onRequest', async request => { if (request.headers['x-test-session'] === 'owner') request.sessionUserId = owner; });
    await app.register(pluginOperationRoutes, { operations });
    const detail = async () => (await manager.get(pluginId)).plugin;
    const configure = async values => manager.configure(pluginId, { expectedRevision: (await detail()).lifecycleRevision,
      updates: Object.entries(values).map(([key, value]) => ({ key, value: value === null ? null : String(value) })) });
    const enable = async enabled => manager.setEnabled(pluginId, { enabled, expectedRevision: (await detail()).lifecycleRevision });
    const request = (action, payload = {}, options = {}) => app.inject({ method: 'POST',
      url: '/api/plugins/' + pluginId + '/actions/teamWorkbench/' + action,
      headers: { host: 'localhost', origin: 'http://localhost', 'x-test-session': 'owner',
        ...(options.confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}) }, payload: { payload: JSON.stringify(payload) } });
    const action = async (name, payload, options) => {
      const r = await request(name, payload, options);
      if (r.statusCode !== 200) throw Object.assign(new Error(r.json().error ?? r.body), { status: r.statusCode });
      return r.json().data;
    };
    const native = async (method, params) => {
      const instance = (await runtime.inventoryStore.snapshot()).instances.find(i => i.pluginId === pluginId);
      const row = params.id ? await action('get', { id: params.id }) : null;
      const value = await withPluginCallContext(instance.pluginInstanceId, { catId, userId: owner,
        threadId: thread.id, invocationId: 'sandbox-simulated-cat',
        source: { kind: 'primary', sourceMessageId: row?.messageId ?? wakes.at(-1)?.[4] ?? 'sandbox-source' }, assertCurrent: async () => {} },
      () => runtime.supervisor.callPluginTool(pluginId, 'team-' + method, 'issue_team_' + method, params));
      return value.data;
    };
    const host = { runtime, manager, app, messages, threads, thread, wakes, schedules, detail, configure, enable, request, action, native,
      close: async () => { await app.close(); await runtime.shutdown('sandbox_shutdown'); hosts.delete(host); } };
    hosts.add(host);
    const installed = (await runtime.inventoryStore.snapshot()).instances.find(i => i.pluginId === pluginId);
    if (!installed) {
      await manager.install({ source: { kind: 'local-archive', path: archive } });
      await configure({ repositories: 'fixture/repo', teamOrganization: 'fixture-org',
    memberProfiles: JSON.stringify(['alice', 'bob'].map(login => ({ login, system: 'macos', role: 'member', weight: 1 }))), analysisCatId: catId,
        analysisThreadId: thread.id, automaticAssignment: false, dispatchMode: 'invitation',
        inboxCatId: catId, inboxThreadId: thread.id, receiveAssignments: name === 'receiver', shareProgress: true });
      await enable(true);
    } else {
      if (installed.packageDigest !== archiveIntegrity) {
        assert.ok(allowArchiveUpgrade, 'Installed sandbox archive differs from its pin; explicit upgrade is required');
        // Host replacement preserves instance identity, configuration and private state.
        await manager.install({ source: { kind: 'local-archive', path: archive } });
      } else {
        await runtime.recoverAfterRestart(); await runtime.lifecycle.drainRestartRecovery();
      }
    }
    return host;
  }
  return { createHost, close, catId };
}
