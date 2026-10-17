import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { BROWSER_SERVICE_LIMITS, requirePluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import module from '@clowder-ai/collective-connector';

// An installed caller must enter through the authorized module, never import domain implementation.
const privateImports = ['CollectiveConnector', 'CollectiveServiceStore', 'startCollectiveServer', 'collectiveStandingWorkSchema'];
for (const name of privateImports) {
  const bypass = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { ${name} } from '@clowder-ai/collective-connector';`],
  { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(bypass.status, 0, `root API must refuse direct import of ${name}`);
  assert.match(bypass.stderr, /does not provide an export/);
}
for (const path of ['business/connector', 'business/service', 'business/contracts', 'dist/business/service/store.js']) {
  await assert.rejects(import('@clowder-ai/collective-connector/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}

const consumer = process.cwd();
const packageRoot = join(consumer, 'node_modules/@clowder-ai/collective-connector');
assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, 'directory installation must materialize the package');
for (const name of ['collective-connector', 'plugin-sdk', 'plugin-contract']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve('@clowder-ai/' + name)));
  assert.ok(!relative(consumer, resolved).startsWith('..'), 'dependency must resolve inside the empty consumer: ' + name);
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const validated = validateManifest(manifest);
assert.equal(validated.valid, true, JSON.stringify(validated.errors));
assert.equal(manifest.runtime.transport, 'builtin');
const skill = manifest.contributions.find(item => item.type === 'skill' && item.id === 'collective-participation');
assert.ok(skill, 'original Collective skill must be an admitted manifest contribution');
assert.equal(skill.path, 'skills/collective-participation');
const skillBody = await readFile(join(packageRoot, skill.path, 'SKILL.md'), 'utf8');
const declaredToolNames = new Set();

const namespace = await import(pathToFileURL(join(packageRoot, manifest.runtime.entrypoint)).href);
const entrypoint = requirePluginModuleEntrypoint(namespace.default);
assert.equal(module, namespace.default, 'public export must identify the same installed module');
const cliEntries = new Set(manifest.contributions.filter(item => item.type === 'mcp').map(item => item.runtime.entrypoint));
async function importTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await importTree(path);
    else if (item.name.endsWith('.js') && !cliEntries.has(relative(packageRoot, path))) await import(pathToFileURL(path).href);
  }
}
await importTree(join(packageRoot, 'dist'));
const fromPackage = createRequire(join(packageRoot, 'package.json'));
const { Client } = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const native = manifest.contributions.find(item => item.type === 'mcp' && item.id === 'collective-native');
const nativeTransport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, native.runtime.entrypoint)],
  env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
const nativeClient = new Client({ name: 'isolated-installed-consumer', version: '1.0.0' });
try {
  await nativeClient.connect(nativeTransport);
  const { tools } = await nativeClient.listTools();
  for (const tool of tools) declaredToolNames.add(tool.name);
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cat_cafe_collective_current_context', 'cat_cafe_collective_read_context',
    'cat_cafe_collective_set_interest', 'cat_cafe_collective_submit_reply', 'cat_cafe_collective_propose_work', 'cat_cafe_collective_accept_work', 'cat_cafe_collective_continue_work'].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'userId'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'invocationId'), false);
  }
} finally { await nativeClient.close(); }

const ownerNative = manifest.contributions.find(item => item.type === 'mcp' && item.id === 'collective-owner-native');
assert.deepEqual(ownerNative.actions, [{ method: 'collective.connector.send' }]);
const ownerClient = new Client({ name: 'isolated-installed-owner-consumer', version: '1.0.0' });
const ownerTransport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, ownerNative.runtime.entrypoint)],
  env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
try {
  await ownerClient.connect(ownerTransport);
  const { tools } = await ownerClient.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['cat_cafe_collective_connector_send']);
  const schema = tools[0].inputSchema;
  assert.equal(schema.additionalProperties, false);
  for (const key of ['agent', 'userId', 'catId', 'sessionRef', 'workResultIntent', 'workProgressIntent'])
    assert.equal(Object.hasOwn(schema.properties, key), false);
} finally { await ownerClient.close(); }

const workNative = manifest.contributions.find(item => item.type === 'mcp' && item.id === 'collective-work-native');
assert.ok(workNative);
const workClient = new Client({name: 'isolated-installed-work-consumer', version: '1.0.0'});
const workTransport = new StdioClientTransport({command: process.execPath, args: [join(packageRoot, workNative.runtime.entrypoint)],
  env: {PATH: process.env.PATH ?? ''}, stderr: 'pipe'});
try {
  await workClient.connect(workTransport);
  const {tools} = await workClient.listTools();
  for (const tool of tools) declaredToolNames.add(tool.name);
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cat_cafe_collective_work_current_context', 'cat_cafe_collective_work_read_context', 'cat_cafe_collective_progress', 'cat_cafe_collective_work_read_artifact', 'cat_cafe_collective_work_register_artifact', 'cat_cafe_collective_work_return_result'].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const field of ['userId', 'catId', 'invocationId', 'taskId', 'executionRef', 'grantRef'])
      assert.equal(Object.hasOwn(tool.inputSchema.properties, field), false);
  }
} finally {await workClient.close();}
for (const name of skillBody.match(/cat_cafe_[a-z_]+/g) ?? []) {
  assert.ok(declaredToolNames.has(name), 'installed skill must name a real public or protected Work tool: ' + name);
}
assert.match(skillBody, /65536/);
console.log(JSON.stringify({declaredSkillMaterialized: true, originalSkillName: skill.id,
  skillBytes: Buffer.byteLength(skillBody), allNamedToolsListedByActualInstalledMcp: true,
  limits: 'File discovery and actual MCP names; agent judgement and real Host skill activation remain independent evidence'}));


await assert.rejects(stat(join(packageRoot, 'dist/business/service/cli.js')), { code: 'ENOENT' });
const directory = await mkdtemp(join(tmpdir(), 'installed-collective-data-'));
const host = {
  dataDirectory: directory,
  config: { async get() { throw new Error('Collective has no configuration-read authority'); } },
  secrets: { async get() { return undefined; } },
  storage: {}, tasks: {listByKind: async () => []}, threads: {}, media: {}, messaging: {}, log() {},
  participantRoster: { async listForNativeContribution() { return []; } },
    nativeContext: { async current() { throw new Error('No native invocation'); } },
    publicInvocations: { async enqueue() { throw new Error('Unused admission port'); } },
    ownerThreads: { async get() { throw new Error('Unused owner thread port'); }, async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
    browserServices: {
    async getBinding(contributionId) { return { contributionId, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} }; },
    async dispatchLocal() { throw new Error('Unused fixture local port'); },
  },
};
let active;
const originalListen = Server.prototype.listen;
let listenerAttempts = 0;
Server.prototype.listen = function () { listenerAttempts++; throw new Error('Package must never listen'); };
async function request(path, init = {}) {
  const caller = { kind: 'http', lane: 'browser', contributionId: 'collective-client-api', requestId: 'installed-request',
    signal: new AbortController().signal, async assertCurrent() {} };
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('origin', 'http://127.0.0.1:5271');
  const response = await active.actions['collective.http.dispatch']({ request: { version: 1, method: init.method ?? 'GET', path,
    rawQuery: '', headers: [...headers.entries()].map(([name, value]) => ({ name, value })), rawBodyBase64: Buffer.from(init.body ?? '').toString('base64') } }, undefined, caller);
  return new Response([204, 304].includes(response.status) ? null : Buffer.from(response.bodyBase64, 'base64'), {
    status: response.status, headers: response.headers.map(row => [row.name, row.value]),
  });
}
try {
  const plugin = entrypoint.create(manifest);
  active = await plugin.start(host);
  const status = (await active.actions['collective.service.status']({})).data;
  const base = status.url;
  assert.equal((await request('/api/health')).status, 200);
  await assert.rejects(() => request('/'), /admitted/, 'C2 assets are served only by Host');
  const linkPath = join(directory, 'service/owner-bootstrap.url');
  assert.equal((await stat(linkPath)).mode & 0o777, 0o600);
  const link = new URL((await readFile(linkPath, 'utf8')).trim());
  const secret = new URLSearchParams(link.hash.slice(1)).get('bootstrap');
  assert.ok(secret);
  const response = await request('/api/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, displayName: 'Isolated installed owner' }),
  });
  assert.equal(response.status, 201);
  const owner = await response.json();
  const created = await request('/api/collectives', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + owner.sessionToken },
    body: JSON.stringify({ name: 'Installed lifecycle proof' }),
  });
  assert.equal(created.status, 201);
  const collective = await created.json();
  await active.stop();
  await assert.rejects(async () => active.actions['collective.service.status']({}), /revoked|stopped/);
  await assert.rejects(readFile(join(directory, 'service/owner-bootstrap.secret')), { code: 'ENOENT' });
  assert.equal(listenerAttempts, 0);
  active = await plugin.start(host);
  const resumed = (await active.actions['collective.service.status']({})).data;
  assert.equal(resumed.serviceInstanceId, status.serviceInstanceId);
  assert.equal(resumed.bootstrapNeeded, false);
  const state = JSON.parse(await readFile(join(directory, 'service/collective-service.json'), 'utf8'));
  assert.equal(state.collectives[collective.collectiveId].name, collective.name);
  await assert.rejects(readFile(linkPath), { code: 'ENOENT' });
  console.log(JSON.stringify({ result: 'PASS', installedDirectory: true, physicalDependencyClosure: true,
    manifest: 'valid', lifecycle: 'start/bootstrap/create/disable/re-enable', statePreserved: true,
    reservedPortsUsed: false, listenerAttempts, binding: 'Host fixture, not actual Host installed acceptance', retainedC2: true, oldCliExcluded: true,
    rejectedPrivateRootImports: privateImports, rejectedInternalSubpaths: 4 }));
} finally {
  Server.prototype.listen = originalListen;
  await active?.stop();
  await rm(directory, { recursive: true, force: true });
}
