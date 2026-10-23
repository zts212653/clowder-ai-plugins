/** Cross-repository integration against unmodified compiled Host code.
 * Not a production-install claim: session/cat/GitHub/grants are explicit test fixtures.
 * Requires ISSUE_WORKBENCH_HOST_ROOT and ISSUE_WORKBENCH_HOST_ARCHIVE; missing inputs fail.
 * The exact archive is installed without rewriting its manifest or entrypoint.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { verifyInstalledHostBrowser } from './helpers/installed-host-browser.mjs';

const pluginId = 'dev.clowder.issue-workbench';
const owner = 'issue-host-test-owner';
const repo = 'fixture/repo';
const grants = ['messaging.send', 'plugin.config.read', 'plugin.state.get', 'plugin.state.set',
  'schedule.register', 'thread.listMetadata', 'thread.readContent'];
const analysis = { category: 'Agent 运行', score: 9, reason: 'Startup is blocked',
  evidence: 'The café cannot start.', blocksRuntime: true, workaround: '' };

test('packed Issue plugin on real isolated Host composition', async t => {
  assert.ok(process.env.ISSUE_WORKBENCH_HOST_ROOT, 'Set ISSUE_WORKBENCH_HOST_ROOT to the compiled Host checkout');
  assert.ok(process.env.ISSUE_WORKBENCH_HOST_ARCHIVE, 'Set ISSUE_WORKBENCH_HOST_ARCHIVE to the exact plugin tgz');
  const hostRoot = resolve(process.env.ISSUE_WORKBENCH_HOST_ROOT);
  const archive = resolve(process.env.ISSUE_WORKBENCH_HOST_ARCHIVE);
  const output = process.env.ISSUE_WORKBENCH_HOST_REPORT_DIR && resolve(process.env.ISSUE_WORKBENCH_HOST_REPORT_DIR);
  const hostStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' });
  const hostBefore = hostStatus();
  const runtimeFiles = ['runtime-composition.js', 'builtin-runtime/carriers/module-plugin-runtime.js',
    'host-surface/plugin-private-storage.js', 'operations/plugin-operation-routes.js',
    'external-runtime/package-staging.js', 'manager/machine-catalog-provider.js'];
  const runtimeDigests = async () => Object.fromEntries(await Promise.all(runtimeFiles.map(async path =>
    [path, createHash('sha256').update(await readFile(join(hostRoot, 'packages/api/dist/domains/plugin', path))).digest('hex')])));
  const root = await mkdtemp(join(tmpdir(), 'issue-installed-host-'));
  // Change before Host imports: its logger must never write to either source checkout.
  process.chdir(root);
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const report = { root, hostHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(),
    archive, integrity: 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64'),
    fixtures: ['owner session', 'cat availability and invocation identity', 'GitHub CLI transport', 'explicit local grant policy', 'schedule runner', 'in-memory Host thread/message stores retained across runtime recreation'],
    nonClaims: ['production login or grant provisioning', 'real model reasoning', 'real GitHub two-account exchange'],
    hostRuntimeDigests: await runtimeDigests(), testGrants: grants, result: 'failed', checks: [] };
  const check = label => { report.checks.push(label); t.diagnostic(label); };
  t.after(async () => {
    report.hostSourceUnchanged = hostBefore === hostStatus();
    report.hostRuntimeUnchanged = JSON.stringify(report.hostRuntimeDigests) === JSON.stringify(await runtimeDigests());
    await writeFile(join(root, 'verification.json'), JSON.stringify(report, null, 2));
    if (output) {
      await mkdir(output, { recursive: true });
      await copyFile(join(root, 'verification.json'), join(output, 'host-verification.json'));
      for (const name of ['host-browser.png', 'host-receiver-browser.png']) {
        try { await copyFile(join(root, name), join(output, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    t.diagnostic('Evidence retained: ' + join(root, 'verification.json'));
    assert.equal(report.hostSourceUnchanged, true, 'Host checkout changed during the test');
    assert.equal(report.hostRuntimeUnchanged, true, 'Compiled Host inputs changed during the test');
  });
  const hostImport = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
  // Host's own registry fixture reads its template, never the user's live catalog.
  await hostImport('test/helpers/setup-cat-registry.js');
  const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await hostImport('dist/domains/plugin/index.js');
  const { MessageStore } = await hostImport('dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await hostImport('dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { InstalledPluginOperations, pluginOperationRoutes } = await hostImport('dist/domains/plugin/operations/plugin-operation-routes.js');
  const { pluginWebhookForwardingRoutes } = await hostImport('dist/routes/plugin/plugin-webhook-forwarding-routes.js');
  const { withPluginCallContext } = await hostImport('dist/domains/plugin/carrier/plugin-call-context.js');
  const { PLUGIN_MANAGER_HOST_POLICIES } = await hostImport('dist/domains/plugin/manager/host-official-catalog.js');
  const { resolveLocalPluginEffectiveGrants } = await hostImport('dist/domains/plugin/manager/machine-catalog-provider.js');
  const requireHost = createRequire(join(hostRoot, 'packages/api/package.json'));
  const Fastify = requireHost('fastify');
  const Redis = requireHost('ioredis');
  // Private Unix socket, port 0 and an owned AOF directory: never connect to a running data service.
  const redisDirectory = join(root, 'redis'); await mkdir(redisDirectory);
  const socket = join(root, 'redis.sock');
  const redisProcess = spawn(process.env.ISSUE_WORKBENCH_REDIS_BIN ?? 'redis-server',
    ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--dir', redisDirectory,
      '--appendonly', 'yes', '--appendfsync', 'always', '--save', ''], { cwd: root, stdio: 'ignore' });
  const redisExit = new Promise((resolve, reject) => { redisProcess.once('exit', resolve); redisProcess.once('error', reject); });
  const redis = new Redis({ path: socket, retryStrategy: count => count < 50 ? 20 : null });
  redis.on('error', () => {});
  const hosts = new Set(), databases = new Map();
  t.after(async () => {
    for (const close of hosts) await close();
    for (const client of databases.values()) client.disconnect();
    redis.disconnect(); redisProcess.kill('SIGTERM'); await redisExit;
  });
  await redis.ping();
  const { catRegistry } = await import(pathToFileURL(join(hostRoot, 'packages/shared/dist/index.js')).href);
  const catId = catRegistry.getAllIds()[0];
  assert.ok(catId, 'Host test registry must contain a cat');
  const github = join(root, 'github.json');
  await writeFile(github, JSON.stringify({ login: 'bob', calls: [], comments: [], issues: [{
    node_id: 'I_test_1', number: 1, title: 'Cannot start', body: 'The café cannot start. No workaround.',
    updated_at: '2026-10-14T10:00:00Z', state: 'open', user: { login: 'alice' }, labels: [], assignees: [],
    html_url: 'https://github.com/fixture/repo/issues/1',
  }] }));
  const githubState = async () => JSON.parse(await readFile(github, 'utf8'));
  const changeGithub = async fn => { const state = await githubState(); fn(state); await writeFile(github, JSON.stringify(state)); };
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!' + process.execPath + '\n' + await readFile(new URL('./helpers/host-github-fixture.mjs', import.meta.url), 'utf8'));
  await chmod(join(bin, 'gh'), 0o700);
  process.env.PATH = bin + ':' + process.env.PATH;
  process.env.ISSUE_HOST_TEST_GITHUB = github;

  async function host(name, grantPolicy = () => grants, prior) {
    const projectRoot = join(root, name); await mkdir(projectRoot, { recursive: true });
    if (!databases.has(name)) databases.set(name, redis.duplicate({ db: databases.size + 1 }));
    const database = databases.get(name);
    const messages = prior?.messages ?? new MessageStore();
    const threads = prior?.threads ?? new ThreadStore();
    const thread = prior?.thread ?? threads.create(owner, 'Isolated Issue integration', projectRoot);
    const wakes = [], schedules = new Map();
    let mcp = null;
    const runtime = createDormantPluginRuntimeComposition({ projectRoot, redis: database, messageStore: messages, threadStore: threads,
      threadOwnerUserId: owner, threadDeepLinkUrl: id => 'http://localhost:3000/thread/' + id,
      threadProjections: { cats: { getAllCatIds: () => [catId], getCatDisplayName: () => 'Fixture analyst',
        getCatAliases: () => ['fixture-analyst'], isCatAvailable: () => true, getRegisteredServices: () => new Map([[catId, {}]]) } },
      invokeTrigger: { trigger: async (...input) => { wakes.push(input); return 'dispatched'; } },
      taskRunner: { registerPostStart: task => schedules.set(task.id, task), unregister: id => schedules.delete(id) },
      mcpConfigIO: { readConfig: async () => mcp, writeAndRegenCli: async value => { mcp = value; }, withLock: fn => fn() },
    });
    const composition = createPluginManagerRuntimeComposition({ runtime,
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
      catalogManifests: [], localGrantPolicy: grantPolicy });
    const manager = composition.manager;
    const operations = new InstalledPluginOperations({ inventory: runtime.inventoryStore,
      configuration: composition.configuration, invocation: runtime.supervisor, settingsInvocation: runtime.settingsInvocation });
    const app = Fastify();
    app.addHook('onRequest', async request => {
      // This replaces only session authentication in app.inject; real route guards/owner carrier remain active.
      if (request.headers['x-test-session'] === 'owner') request.sessionUserId = owner;
    });
    await app.register(pluginOperationRoutes, { operations });
    await app.register(pluginWebhookForwardingRoutes, { webhooks: runtime.supervisor });
    const detail = async () => (await manager.get(pluginId)).plugin;
    const configure = async values => manager.configure(pluginId, { expectedRevision: (await detail()).lifecycleRevision,
      updates: Object.entries(values).map(([key, value]) => ({ key, value: value === null ? null : String(value) })) });
    const enable = async enabled => manager.setEnabled(pluginId, { enabled, expectedRevision: (await detail()).lifecycleRevision });
    const request = (action, payload = {}, options = {}) => app.inject({ method: 'POST',
      url: '/api/plugins/' + pluginId + '/actions/' + (options.operation ?? 'teamWorkbench') + '/' + action,
      headers: { host: 'localhost', origin: 'http://localhost', 'x-test-session': 'owner',
        ...(options.confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}), ...options.headers },
      payload: { payload: JSON.stringify(payload) } });
    const action = async (name, payload, options) => {
      const response = await request(name, payload, options);
      assert.equal(response.statusCode, 200, name + ': ' + response.body);
      return response.json().data;
    };
    const native = async (method, params, callerCat = catId) => {
      const instance = (await runtime.inventoryStore.snapshot()).instances.find(i => i.pluginId === pluginId);
      const value = await withPluginCallContext(instance.pluginInstanceId, { catId: callerCat, userId: owner,
        threadId: thread.id, invocationId: 'fixture-invocation', source: { kind: 'primary', sourceMessageId: wakes.at(-1)?.[4] ?? 'fixture-source' },
        assertCurrent: async () => {} },
      () => runtime.supervisor.callPluginTool(pluginId, 'team-' + method, 'issue_team_' + method, params));
      return value.data;
    };
    const close = async () => { await app.close(); await runtime.shutdown('isolated_test'); hosts.delete(close); };
    hosts.add(close);
    return { runtime, manager, app, messages, threads, thread, wakes, schedules, detail, configure, enable, request, action, native, close };
  }
  const initial = await host('default-policy', manifest => resolveLocalPluginEffectiveGrants(PLUGIN_MANAGER_HOST_POLICIES, manifest));
  await initial.manager.install({ source: { kind: 'local-archive', path: archive } });
  assert.deepEqual((await initial.runtime.inventoryStore.snapshot()).grants[0].effectiveGrants, []);
  check('Exact archive admits without rewriting; shipped Host policy grants no capabilities');
  const unpacked = join(root, 'unpacked'); await mkdir(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);

  let sender = await host('sender');
  await sender.manager.install({ source: { kind: 'local-archive', path: archive } });
  await sender.configure({ repositories: repo, teamOrganization: 'fixture-org', analysisCatId: catId,
    analysisThreadId: sender.thread.id, automaticAssignment: false, dispatchMode: 'invitation',
    receiveAssignments: false, shareProgress: true });
  await sender.enable(true);
  assert.equal((await sender.detail()).live, 'running');
  assert.equal(sender.schedules.size, 1);
  const asset = await sender.app.inject({ method: 'GET', url: '/api/plugins/' + pluginId + '/workbench/installed.html',
    headers: { host: 'localhost', 'x-test-session': 'owner' } });
  assert.equal(asset.statusCode, 200, asset.body);
  assert.match(asset.headers['content-type'], /text\/html/);
  assert.match(asset.body, /installed.js/);
  const deniedAsset = await sender.app.inject({ method: 'GET', url: '/api/plugins/' + pluginId + '/workbench/installed.html', headers: { host: 'localhost' } });
  assert.equal(deniedAsset.statusCode, 401);
  check('Packed workbench page is served through the existing authenticated Host webhook route');
  assert.equal((await sender.runtime.supervisor.listPluginTools(pluginId)).length, 9);
  const unauthenticated = await sender.request('summary', {}, { headers: { 'x-test-session': '' } });
  assert.equal(unauthenticated.statusCode, 401);
  const initialView = await sender.action('summary', { repo, number: 1 });
  assert.deepEqual(initialView.issueContext.assignmentOptions.members, ['alice', 'bob']);
  check('Real install/configuration/enable/tool registration/owner route guards');
  const job = await sender.action('analyze', { repo, number: 1, requestId: 'integration-analysis' });
  assert.equal(job.status, 'delivered');
  await sender.action('analyze', { repo, number: 1, requestId: 'integration-analysis' });
  assert.equal(sender.wakes.length, 1);
  await sender.native('submit', { id: job.id, analysis });
  const inspected = await sender.action('get', { id: job.id });
  assert.equal(inspected.analysis.score, 9);
  await sender.action('feedback', { id: job.id, verdict: 'corrected', reason: 'Fixture owner review', expectedRevision: inspected.revision });
  assert.equal((await sender.action('summary')).statistics.corrected, 1);
  check('Host message publication/wake boundary, idempotence, native analysis result and owner feedback');
  const input = { repo, number: 1, requestId: 'integration-invitation', login: 'alice',
    sourceVersion: initialView.issueContext.sourceVersion, delivery: 'invitation' };
  const denied = await sender.request('assignIssue', input);
  assert.notEqual(denied.statusCode, 200);
  assert.equal((await githubState()).comments.length, 0);
  const dispatch = await sender.action('assignIssue', input, { confirmed: true });
  assert.equal(dispatch.assignment.status, 'invited');
  await sender.action('assignIssue', input, { confirmed: true });
  assert.equal((await githubState()).comments.length, 1);
  assert.deepEqual((await githubState()).issues[0].assignees, []);
  check('Owner confirmation is required; invitation publishes once without changing assignees');
  await sender.enable(false);
  assert.equal(sender.schedules.size, 0);
  await assert.rejects(sender.native('inspect', { repo, number: 1 }));
  await sender.close();
  sender = await host('sender', () => grants, sender);
  await sender.runtime.recoverAfterRestart();
  await sender.runtime.lifecycle.drainRestartRecovery();
  assert.equal((await sender.detail()).intent, 'disabled');
  await sender.enable(true);
  assert.equal((await sender.action('get', { id: job.id })).analysis.score, 9);
  assert.equal((await sender.action('summary')).statistics.corrected, 1);
  check('Disable removes tools/schedules; recreated Host recovers Redis-backed analysis and feedback');
  const queue = await sender.action('planClassification', { repo, catId, requestId: 'integration-queue' });
  assert.equal(queue.status, 'paused');
  assert.equal(queue.items.length, 1);
  const running = await sender.action('controlClassification', { id: queue.id, expectedRevision: queue.revision, status: 'running' });
  const paused = await sender.action('controlClassification', { id: queue.id, expectedRevision: running.revision, status: 'paused' });
  await sender.native('submit', { id: running.items[0].jobId, analysis });
  await sender.action('controlClassification', { id: queue.id, expectedRevision: paused.revision, status: 'running' });
  await [...sender.schedules.values()][0].run.execute({});
  assert.equal((await sender.action('summary')).classificationQueues[0].status, 'completed');
  check('Classification queue plan/start/pause/resume/completion through Host-declared schedule');
  await verifyInstalledHostBrowser({ root, unpacked: join(unpacked, 'package'), sender, githubState, analysis });
  check('Packed browser saves/reloads a local plan and receives an analysis via real Host owner routes and storage');

  await sender.enable(false);
  await changeGithub(state => { state.login = 'alice'; });
  let receiver = await host('receiver');
  await receiver.manager.install({ source: { kind: 'local-archive', path: archive } });
  await receiver.configure({ repositories: repo, teamOrganization: 'fixture-org', inboxCatId: catId,
    inboxThreadId: receiver.thread.id, receiveAssignments: true, shareProgress: true });
  await receiver.enable(true);
  const inbox = (await receiver.action('summary', { kind: 'inbox' })).rows;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, 'delivered');
  assert.equal(receiver.wakes.length, 1);
  assert.equal((await githubState()).comments.length, 1, 'delivery is not acceptance');
  await receiver.native('receive', {});
  assert.equal(receiver.wakes.length, 1);
  await verifyInstalledHostBrowser({ root, sender: receiver, inboxId: inbox[0].id });
  assert.equal(receiver.wakes.length, 1, 'acceptance must not impersonate owner speech or claim execution');
  assert.equal((await receiver.action('get', { id: inbox[0].id })).ownerAcceptance.userId, owner);
  check('Installed browser persists explicit owner acceptance and offers the original conversation plus an owner-sendable start instruction');
  await receiver.native('report', { id: inbox[0].id, status: 'accepted', summary: 'Fixture member explicitly accepts', evidenceUrls: [] });
  assert.equal((await githubState()).comments.length, 2);
  assert.equal((await githubState()).comments[1].user.login, 'alice');
  const reportDetail = await receiver.action('get', { id: inbox[0].id });
  assert.equal(reportDetail.sharedReceipts[0].status, 'accepted');
  check('Independent receiver inventory/database catches invitation; explicit native receipt uses receiver account');
  await receiver.close();
  await changeGithub(state => { state.offline = true; });
  receiver = await host('receiver', () => grants, receiver);
  await receiver.runtime.recoverAfterRestart();
  await receiver.runtime.lifecycle.drainRestartRecovery();
  const health = await receiver.action('status', {}, { operation: 'teamStatus' });
  assert.match(health.recovery.results.find(result => result.id === 'inbox').error, /unavailable|GitHub/);
  assert.equal(receiver.wakes.length, 0);
  await changeGithub(state => { state.offline = false; });
  await [...receiver.schedules.values()][0].run.execute({});
  assert.equal(receiver.wakes.length, 0, 'recovery must not redeliver an acknowledged message');
  assert.equal((await receiver.action('summary', { kind: 'inbox' })).rows[0].id, inbox[0].id);
  assert.equal((await receiver.action('get', { id: inbox[0].id })).ownerAcceptance.userId, owner);
  await changeGithub(state => { state.issues[0].state = 'closed'; });
  await receiver.native('receive', {});
  assert.equal((await receiver.action('summary', { kind: 'inbox' })).rows[0].status, 'inactive');
  await assert.rejects(receiver.native('report', { id: inbox[0].id, status: 'working', summary: 'Stale fixture', evidenceUrls: [] }));
  assert.equal((await githubState()).comments.length, 2);
  check('Offline restart retains inbox; schedule recovers; source withdrawal blocks stale receipts');
  await receiver.configure({ repositories: '' });
  await assert.rejects(receiver.native('inspect', { repo, number: 1 }), /Configure allowed repositories/);
  await receiver.enable(false);
  await assert.rejects(receiver.native('inspect', { repo, number: 1 }), /not active/);
  assert.equal(receiver.schedules.size, 0);
  assert.equal((await githubState()).comments.length, 2);
  check('Repository access withdrawal and Manager disable stop further work and remove scheduled/native access');
  await changeGithub(state => {
    state.login = 'bob';
    state.issues.push({ ...state.issues[0], node_id: 'I_test_2', number: 2, html_url: 'https://github.com/fixture/repo/issues/2' },
      { ...state.issues[0], node_id: 'I_test_3', number: 3, state: 'open', user: { login: 'outsider' }, html_url: 'https://github.com/fixture/repo/issues/3' });
  });
  const flows = await host('two-flows');
  await flows.manager.install({ source: { kind: 'local-archive', path: archive } });
  await flows.configure({ repositories: repo, teamOrganization: 'fixture-org', analysisCatId: catId,
    analysisThreadId: flows.thread.id, initialClassification: true, automaticAssignment: false,
    receiveAssignments: false, dispatchMode: 'invitation', routingRules: JSON.stringify([{ login: 'alice', categories: ['代码与交付'], features: [] }]) });
  await flows.enable(true);
  const flowQueue = (await flows.action('summary')).classificationQueues[0];
  assert.equal(flowQueue.origin, 'integration'); assert.equal(flowQueue.items.length, 3);
  const snapshot = await flows.action('coordination', { action: 'load' });
  const source = snapshot.sources[0], fact = source.issues.find(issue => issue.number === 3);
  const { newInvestigation } = await import(pathToFileURL(join(unpacked, 'package/dist/index.js')).href);
  const work = newInvestigation({ sourceId: source.profile.id, issueId: fact.id, number: fact.number }, fact.title, fact.contentVersion, source.preference.value);
  work.module = '代码与交付'; work.notes = 'Private human decision retained only in local storage';
  await flows.action('coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  const beforeBatch = (await githubState()).comments.length;
  await flows.configure({ automaticAssignment: true });
  assert.equal((await githubState()).comments.length, beforeBatch + 1, 'human classification dispatch does not wait for initial cat analysis');
  assert.equal(flows.wakes.length, 1, 'only the first initial analysis is outstanding');
  for (let i = 0; i < 3; i++) {
    const pending = (await flows.action('summary', { kind: 'analysis' })).rows.find(row => !row.analysis);
    assert.ok(pending); await flows.native('submit', { id: pending.id, analysis });
    await [...flows.schedules.values()][0].run.execute({});
  }
  await [...flows.schedules.values()][0].run.execute({});
  assert.equal((await flows.action('summary')).classificationQueues[0].status, 'completed');
  assert.equal(flows.wakes.length, 3); assert.equal((await githubState()).comments.length, beforeBatch + 1);
  const finalSnapshot = await flows.action('coordination', { action: 'load' });
  assert.equal(finalSnapshot.sources[0].work[0].value.module, '代码与交付');
  assert.ok(!(await githubState()).comments.at(-1).body.includes(work.notes));
  await flows.enable(false);
  check('Initial classification covers Open and Closed once; independent human-category batch dispatch runs before analysis and never duplicates its invitation');
  report.result = 'passed-with-explicit-fixtures';
});
