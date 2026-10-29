import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const isolationRoot = process.env.C1_ISOLATED_CONSUMER_ROOT;
assert.ok(isolationRoot, 'installed journey must run inside the parent test isolation');
assert.equal(await realpath(homedir()), await realpath(join(isolationRoot, 'home')));
assert.equal(process.env.COLLECTIVE_SERVICE_DATA_DIR, join(isolationRoot, 'unexpected-launcher-data'));
assert.equal(process.env.COLLECTIVE_SERVICE_PORT, '0');
assert.deepEqual(Object.keys(process.env).filter(key => /^(?:COLLECTIVE_|REDIS|CAT_CAFE|CALLBACK|GH_|GITHUB_)/.test(key)).sort(),
  ['COLLECTIVE_SERVICE_DATA_DIR', 'COLLECTIVE_SERVICE_HOST', 'COLLECTIVE_SERVICE_PORT']);
const packageRoot = join(consumer, 'node_modules/@clowder-ai/collective-connector');
const fromPackage = createRequire(join(packageRoot, 'package.json'));
function resolveModule(name) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    'process.stdout.write(import.meta.resolve(process.argv[1]))', name], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const { validateManifest } = await import(resolveModule('@clowder-ai/plugin-contract'));
const { requirePluginModuleEntrypoint } = await import(resolveModule('@clowder-ai/plugin-sdk'));
// Validate the raw plugin envelope against the installed Contract, before the
// Host adds its own `ok` wrapper. Checking only `.data` misses Manager 502s.
const fromContract = createRequire(resolveModule('@clowder-ai/plugin-contract'));
const Ajv = fromContract('ajv/dist/2020');
const ajv = new Ajv({ allErrors: true, strict: false });
fromContract('ajv-formats')(ajv);
let manifestSchema;
for (const name of ['plugin-metadata', 'signals', 'messaging', 'manifest']) {
  const schema = JSON.parse(await readFile(fileURLToPath(resolveModule('@clowder-ai/plugin-contract/schemas/' + name)), 'utf8'));
  ajv.addSchema(schema, schema.$id);
  if (name === 'manifest') manifestSchema = schema;
}
const operationResult = ajv.getSchema(manifestSchema.$id + '#/$defs/OperationActionResult');
assert.ok(operationResult);
for (const invalid of [{data: {}}, {render: 'status', data: {}, ok: true}])
  assert.equal(operationResult(invalid), false, 'raw owner result must respect the formal Contract');
function assertOperationResult(result) {
  assert.equal(operationResult(result), true, JSON.stringify(operationResult.errors));
  assert.ok(result.render.length > 0, 'Manager additionally requires a nonempty render string');
}

assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, 'directory installation must materialize the package');
for (const name of ['collective-connector', 'plugin-sdk', 'plugin-contract']) {
  const resolved = await realpath(fileURLToPath(resolveModule('@clowder-ai/' + name)));
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
const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
for (const path of Object.values(packageManifest.bin ?? {})) cliEntries.add(path);
async function importTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await importTree(path);
    else if (item.name.endsWith('.js') && !cliEntries.has(relative(packageRoot, path))) await import(pathToFileURL(path).href);
  }
}
// Explicit executables are exercised separately; importing the module closure must never start a Service.
assert.equal(packageManifest.bin['clowder-collective-service'], 'dist/business/service/cli.js');
assert.ok((await stat(join(packageRoot, packageManifest.bin['clowder-collective-service']))).isFile());
await importTree(join(packageRoot, 'dist'));
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
    'cat_cafe_collective_set_interest', 'cat_cafe_collective_submit_reply', 'cat_cafe_collective_propose_work', 'cat_cafe_collective_accept_work', 'cat_cafe_collective_continue_work',
    'cat_cafe_collective_artifact_command', 'cat_cafe_collective_suggest_project_work', 'cat_cafe_collective_prepare_sticker',
    'cat_cafe_collective_project_context', 'cat_cafe_collective_read_material', 'cat_cafe_collective_suggest_material',
    'cat_cafe_collective_suggest_work_time'].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'userId'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'invocationId'), false);
  }
  const readTool = tools.find(tool => tool.name === 'cat_cafe_collective_read_context');
  assert.ok(readTool.inputSchema.properties.attachment);
  const ambiguous = await nativeClient.callTool({ name: readTool.name, arguments: {
    contextRef: 'explicit-context-fixture',
    image: { eventId: 'evt_abcdefghijk', attachmentId: 'att_abcdefghijk' },
    attachment: { eventId: 'evt_abcdefghijk', attachmentId: 'att_abcdefghijk' },
  } });
  assert.equal(ambiguous.isError, true);
  assert.match(JSON.stringify(ambiguous.content), /Choose one attachment selector/);
  const emptyReply = await nativeClient.callTool({ name: 'cat_cafe_collective_submit_reply', arguments: {
    returnRef: 'explicit-return-fixture', replyOperationRef: 'explicit-reply-fixture', body: '',
  } });
  assert.equal(emptyReply.isError, true);
  assert.match(JSON.stringify(emptyReply.content), /A message needs text or content/);
} finally { await nativeClient.close(); }

const ownerNative = manifest.contributions.find(item => item.type === 'mcp' && item.id === 'collective-owner-native');
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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cat_cafe_collective_work_current_context', 'cat_cafe_collective_work_read_context', 'cat_cafe_collective_progress', 'cat_cafe_collective_work_read_artifact', 'cat_cafe_collective_work_register_artifact', 'cat_cafe_collective_work_return_result', 'cat_cafe_collective_work_artifact_command', 'cat_cafe_collective_work_time', 'cat_cafe_collective_work_project_context', 'cat_cafe_collective_work_read_material', 'cat_cafe_collective_work_suggest_material'].sort());
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


const directory = await mkdtemp(join(tmpdir(), 'installed-collective-data-'));
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
assert.ok(![3001, 3002].includes(port));
const data = new Map(); let revision = 0;
const host = {
  pluginInstanceId:'installed-collective', dataPath: directory,
  config: { async get(key) { return key === 'servicePort' ? String(port) : undefined; } },
  secrets: { async get() { return undefined; } },
  storage: {
    async get(key) { return structuredClone(data.get(key)); },
    async list() { return structuredClone(Object.fromEntries(data)); },
    async set(key, value) { const entry = {revision: ++revision, value: structuredClone(value)}; data.set(key, entry); return {revision}; },
    async compareAndSet(key, expected, value) {
      if ((data.get(key)?.revision ?? null) !== expected) return {applied: false};
      data.set(key, {revision: ++revision, value: structuredClone(value)}); return {applied: true, revision};
    },
    async delete(key) { return {deleted: data.delete(key)}; },
  },
  tasks: {list: async () => []}, threads: {async list(){return [];}},
  streams: {async *read(){throw new Error('Unused');}},
  messaging: {async get(){return null;}, async subscribe(){}, async unsubscribe(){}},
  log() {}, members: {async list(){return [];},async get(){return null;}},
};
let active;
const base = `http://127.0.0.1:${port}`;
async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('origin', base);
  return fetch(base + path, {...init, headers});
}
try {
  const plugin = entrypoint.create(manifest);
  active = await plugin.start(host);
  const statusResult = await active.actions['collective.service.status']({});
  assertOperationResult(statusResult);
  const status = statusResult.data;
  assert.equal(status.url, base);
  assert.equal(status.bootstrapNeeded, true, 'fresh installation cannot depend on a retained bootstrap');
  for (const [operationKey, method] of [['recovery', 'collective.recovery.list'],
    ['participation', 'collective.owner.connections'], ['work', 'collective.work.owner.connections']]) {
    const caller = {kind: 'owner-operation', userId: 'installed-owner', pluginInstanceId: host.pluginInstanceId,
      operationKey, actionId: 'list', requestId: 'fresh-installed-list', signal: new AbortController().signal,
      async assertCurrent() {}};
    const input = {input: {servicePort: String(port)}, operationState: {currentAction: 'list', updatedAt: Date.now()}};
    const result = await active.actions[method](input, undefined, caller);
    assertOperationResult(result);
    assert.equal(result.render, 'rows'); assert.deepEqual(result.data.rows, []);
    await assert.rejects(async () => active.actions[method]({...input, input: {...input.input, userId: 'forged'}}, undefined, caller));
  }
  const attentionOperation = manifest.configuration.find(item => item.key === 'accountability');
  const attentionAction = attentionOperation.actions.find(item => item.id === 'attention');
  const attention = await active.actions[attentionAction.action.method]({input: {servicePort: String(port)},
    operationState: {currentAction: 'attention', updatedAt: Date.now()}}, undefined,
  {kind: 'owner-operation', userId: 'installed-owner', pluginInstanceId: host.pluginInstanceId,
    operationKey: attentionOperation.key, actionId: attentionAction.id, requestId: 'fresh-installed-attention',
    signal: new AbortController().signal, async assertCurrent() {}});
  assertOperationResult(attention);
  assert.equal(attention.render, attentionAction.resultRender);
  assert.deepEqual(attention.data.items, []);
  assert.deepEqual(attention.data.reasons, []);
  assert.equal(attention.data.state.status, 'available');
  assert.equal(attention.data.state.exhaustiveness, 'complete');
  assert.equal(attention.data.state.coverage, 'pending_f290_collective_accountability_requests');
  assert.equal(typeof attention.data.state.startedAt, 'number');
  assert.equal(typeof attention.data.state.observedAt, 'number');
  const provision = manifest.contributions.find(item => item.type === 'webhook' && item.path === 'service/provision');
  const launch = await active.actions['collective.control.http']({request: {method: 'POST', path: 'service/provision',
    headers: {origin: base}, principal: {kind: 'owner', id: 'installed-owner'}}}, undefined,
  {kind: 'owner-http-request', userId: 'installed-owner', pluginInstanceId: host.pluginInstanceId, operation: 'write',
    signal: new AbortController().signal, async assertCurrent() {}, requestIdentity: {kind: 'owner_http',
      userId: 'installed-owner', pluginId: manifest.pluginId, pluginInstanceId: host.pluginInstanceId,
      requestId: 'fresh-installed-provision', contributionId: provision.id, declaredPath: provision.path,
      path: 'service/provision', method: 'POST'}});
  assert.equal(launch.status, 200);
  assert.equal(launch.body.service.bootstrapNeeded, true);
  assert.ok(launch.body.launchUrl.startsWith(base + '#bootstrap='), 'fresh owner receives the actionable setup URL');
  assert.equal(JSON.stringify(status).includes('#bootstrap='), false, 'private bootstrap is never public status data');
  assert.equal(active.actions['collective.http.dispatch'], undefined);
  assert.equal((await request('/api/health')).status, 200);
  const clientManifest = JSON.parse(await readFile(join(packageRoot, 'assets/client/manifest.json'), 'utf8'));
  for (const file of clientManifest.files) {
    const response = await request(file.path === '/index.html' ? '/' : file.path);
    assert.equal(response.status, 200, file.path);
    assert.equal(response.headers.get('content-type'), file.contentType);
    const bytes = Buffer.from(await response.arrayBuffer());
    // Fetch decodes gzip, while Content-Length describes the encoded wire body.
    // The decoded manifest length and digest are still checked below for every public asset.
    if (!response.headers.get('content-encoding')) {
      assert.equal(Number(response.headers.get('content-length')), bytes.length);
    }
    if (file.path === '/index.html') {
      const retained = await readFile(join(packageRoot, 'assets/client/index.html'));
      assert.equal(retained.length, file.size);
      assert.equal(createHash('sha256').update(retained).digest('hex'), file.sha256);
      const html = bytes.toString('utf8');
      const nonceTag = /<meta name="collective-widget-nonce" content="([A-Za-z0-9_-]+)">/gu;
      const matches = [...html.matchAll(nonceTag)];
      assert.equal(matches.length, 1);
      assert.equal(html.replace(matches[0][0], ''), retained.toString('utf8'));
      assert.ok(response.headers.get('content-security-policy').includes(`'nonce-${matches[0][1]}'`));
      assert.equal(response.headers.get('content-security-policy').includes("'unsafe-inline'"), false);
      const reopened = await request('/');
      assert.equal(reopened.status, 200);
      const reopenedTags = [...(await reopened.text()).matchAll(nonceTag)];
      assert.equal(reopenedTags.length, 1);
      assert.notEqual(reopenedTags[0][1], matches[0][1]);
      assert.ok(reopened.headers.get('content-security-policy').includes(`'nonce-${reopenedTags[0][1]}'`));
      assert.equal(createHash('sha256').update(await readFile(join(packageRoot, 'assets/client/index.html'))).digest('hex'), file.sha256);
    } else {
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
  }
  assert.equal((await request('/owner-bootstrap.secret')).status, 404);
  assert.notEqual((await request('/api/auth/github/callback')).status, 404, 'OAuth callback remains mounted');
  assert.equal((await fetch(base + '/api/meta', {method:'OPTIONS', headers:{origin:'https://untrusted.example'}})).status, 403);
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
  await active.stop({reason:'test'});
  await assert.rejects(async () => active.actions['collective.service.status']({}), /revoked|stopped/);
  await assert.rejects(readFile(join(directory, 'service/owner-bootstrap.secret')), { code: 'ENOENT' });
  await assert.rejects(fetch(base), /fetch failed/);
  active = await plugin.start(host);
  const resumed = (await active.actions['collective.service.status']({})).data;
  assert.equal(resumed.serviceInstanceId, status.serviceInstanceId);
  assert.equal(resumed.bootstrapNeeded, false);
  const state = JSON.parse(await readFile(join(directory, 'service/collective-service.json'), 'utf8'));
  assert.equal(state.collectives[collective.collectiveId].name, collective.name);
  await assert.rejects(readFile(linkPath), { code: 'ENOENT' });
  console.log(JSON.stringify({ result: 'PASS', installedDirectory: true, physicalDependencyClosure: true,
    manifest: 'valid', lifecycle: 'start/bootstrap/create/disable/re-enable', statePreserved: true,
    reservedPortsUsed: false, pluginOwnsListener: true, packagedAssetsVerified: true,
    hostAcceptance: 'isolated SDK caller, not actual Host installed acceptance', supportedStandaloneBin: true,
    isolatedHome: true, inheritedServiceCredentialsRemoved: true,
    rejectedPrivateRootImports: privateImports, rejectedInternalSubpaths: 4 }));
} finally {
  await active?.stop({reason:'test'});
  await rm(directory, { recursive: true, force: true });
}
