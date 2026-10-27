import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [hostRoot, archive, expectedArchiveSha256] = process.argv.slice(2);
assert.ok(hostRoot && archive, 'explicit frozen Host root and prepared archive are required');
assert.match(expectedArchiveSha256 ?? '', /^[a-f0-9]{64}$/, 'explicit prepared archive SHA256 is required');
const archiveBytes = await readFile(archive);
assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), expectedArchiveSha256);
const expectedDigest = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
const expectedClosure = process.env.F202_COLLECTIVE_HOST_DEPENDENCY_CLOSURE ?? 'shipped';
assert.ok(['shipped', 'materialized'].includes(expectedClosure), 'explicit supported dependency closure is required');
const expectedHead = process.env.F202_COLLECTIVE_HOST_HEAD;
assert.match(expectedHead ?? '', /^[a-f0-9]{40}$/, 'explicit frozen current Host HEAD is required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(), expectedHead);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' }).trim(), '');
const temporary = await mkdtemp(join(tmpdir(), 'collective-host-admission-'));
// Isolate the child before any transitive Host import initializes a logger,
// Redis client or default path. These are fixture ports, never a running Host.
for (const key of Object.keys(process.env)) {
  if (/^(?:CAT_CAFE|COLLECTIVE_|REDIS|CALLBACK|GH_|GITHUB_)/.test(key)) delete process.env[key];
}
const home = join(temporary, 'home');
await mkdir(home);
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local/share'), LOG_DIR: join(temporary, 'logs'), NODE_ENV: 'test',
  REDIS_HOST: '127.0.0.1', REDIS_PORT: '1', REDIS_URL: 'redis://127.0.0.1:1',
  COLLECTIVE_SERVICE_HOST: '127.0.0.1', COLLECTIVE_SERVICE_PORT: '0',
  COLLECTIVE_SERVICE_DATA_DIR: join(temporary, 'unexpected-launcher-data'),
});
let runtime;
let instanceId;
try {
  const domainRoot = join(hostRoot, 'packages/api/dist/domains');
  const hostBuildInputs = {};
  const load = async path => {
    const absolutePath = join(domainRoot, path);
    const sourcePath = `packages/api/src/domains/${path.replace(/\.js$/, '.ts')}`;
    const source = await readFile(join(hostRoot, sourcePath));
    const committedSource = execFileSync('git', ['show', `${expectedHead}:${sourcePath}`], { cwd: hostRoot });
    assert.deepEqual(source, committedSource, `Host source must match frozen HEAD: ${sourcePath}`);
    hostBuildInputs[path] = {
      distSha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
      sourcePath,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      sourceGitBlob: execFileSync('git', ['rev-parse', `${expectedHead}:${sourcePath}`], { cwd: hostRoot, encoding: 'utf8' }).trim(),
    };
    return import(pathToFileURL(absolutePath).href);
  };
  const { LocalPluginPackageAdmission } = await load('plugin/manager/local-package-admission.js');
  const { FilePluginInventoryStore } = await load('plugin/host-inventory/stores.js');
  const { HostInventoryControlPlane } = await load('plugin/host-inventory/control-plane.js');
  const { FilesystemVerifiedPluginPackageLocator } = await load('plugin/external-runtime/filesystem-package-locator.js');
  const { FilesystemBuiltinPluginPackageMaterializer } = await load('plugin/manager/package-assets/builtin-package-materializer.js');
  const { ModulePluginRuntime } = await load('plugin/builtin-runtime/carriers/module-plugin-runtime.js');
  const { requestedDataDirectoryName } = await load('plugin/host-inventory/data-directory-name.js');
  const { TaskStore } = await load('cats/services/stores/ports/TaskStore.js');
  const taskStore = new TaskStore();
  const ownerUserId = 'isolated-host-owner';
  const packagesRoot = join(temporary, 'packages');
  const inventoryPath = join(temporary, 'inventory.json');
  const inventory = new FilePluginInventoryStore(inventoryPath);
  const control = new HostInventoryControlPlane(inventory);
  let port = 0;
  const configuration = { async readConfig(_id, key) { return key === 'servicePort' ? String(port) : undefined; }, async readSecret() { return undefined; } };
  const values = new Map(); let revision = 0;
  const storage = {
    async get(id,key){return structuredClone(values.get(id+':'+key));},
    async list(id){return Object.fromEntries([...values].filter(([key])=>key.startsWith(id+':')).map(([key,value])=>[key.slice(id.length+1),structuredClone(value)]));},
    async set(id,key,value){values.set(id+':'+key,{revision:++revision,value:structuredClone(value)});return {revision};},
    async compareAndSet(id,key,expected,value){if((values.get(id+':'+key)?.revision??null)!==expected)return {applied:false};values.set(id+':'+key,{revision:++revision,value:structuredClone(value)});return {applied:true,revision};},
    async delete(id,key){return {deleted:values.delete(id+':'+key)};},
  };
  runtime = new ModulePluginRuntime({ taskStore, taskOwnerUserId: ownerUserId,
    taskThreadStore: { async get() { return null; } }, storage, neutral:async()=>({members:{list:async()=>[],get:async()=>null}}), packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    materializer: new FilesystemBuiltinPluginPackageMaterializer({ packagesRoot }),
    configuration, dataDirectoryParent: join(temporary, 'data'), log() {},
  });
  async function listen(probe, value = 0) {
    await new Promise((resolve, reject) => {
      probe.once('error', reject); probe.listen(value, '127.0.0.1', resolve);
    });
    return probe.address().port;
  }
  async function close(probe) {
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
  const admission = new LocalPluginPackageAdmission({ packagesRoot, inventory: control });
  const installed = await admission.install({ kind: 'local-archive', path: archive }, { expectedDigest });
  instanceId = installed.pluginInstanceId;
  const snapshot = await new FilePluginInventoryStore(inventoryPath).snapshot();
  assert.equal(snapshot.instances.length, 1, 'actual inventory survives reload');
  const record = snapshot.packages[0];
  assert.equal(record.provenance.kind, 'local-archive');
  assert.equal(record.provenance.dependencyClosure, expectedClosure);
  assert.equal(record.packageDigest, expectedDigest, 'archive admission preserves the exact frozen bytes');
  assert.equal(snapshot.instances[0].pluginInstanceId, instanceId);
  assert.equal(record.pluginId, 'official.collective-connector');
  assert.equal(runtime.claims(record), true);
  const probe = createServer(); port = await listen(probe); await close(probe);
  const dataRoot = join(temporary, 'data', requestedDataDirectoryName(record.manifest));
  const brokenLink = join(dataRoot, 'service/owner-bootstrap.url');
  await mkdir(brokenLink, { recursive: true });
  await assert.rejects(runtime.start(instanceId, record), /EISDIR|EEXIST|ENOTEMPTY/);
  assert.equal(runtime.actions(instanceId), undefined, 'failed Host activation publishes no actions');
  const released = createServer(); await listen(released, port); await close(released);
  await rm(brokenLink, { recursive: true });
  await runtime.start(instanceId, record);
  const status = (await runtime.invoke(instanceId, 'collective.service.status', {})).data;
  assert.equal((await fetch(status.url + '/api/health', { signal: AbortSignal.timeout(5_000) })).status, 200);
  const bootstrapLink = new URL((await readFile(brokenLink, 'utf8')).trim());
  const secret = new URLSearchParams(bootstrapLink.hash.slice(1)).get('bootstrap');
  const claim = await fetch(status.url + '/api/bootstrap', { method: 'POST', signal: AbortSignal.timeout(5_000), headers: { origin: status.url, 'content-type': 'application/json' },
    body: JSON.stringify({ secret, displayName: 'Host admitted isolated owner' }),
  });
  assert.equal(claim.status, 201, 'Host retry preserves unclaimed credential');
  await runtime.stop(instanceId, 'disabled');
  await assert.rejects(runtime.invoke(instanceId, 'collective.service.status', {}));
  const disabled = createServer(); await listen(disabled, port); await close(disabled);
  await runtime.start(instanceId, record);
  const resumed = (await runtime.invoke(instanceId, 'collective.service.status', {})).data;
  assert.equal(resumed.serviceInstanceId, status.serviceInstanceId);
  assert.equal(resumed.bootstrapNeeded, false);
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expectedArchiveSha256);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(), expectedHead);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' }).trim(), '');
  console.log(JSON.stringify({ result: 'PASS', hostHead: expectedHead, archiveAdmission: 'production', archiveSha256: expectedArchiveSha256,
    inventory: 'file/reloaded', provenance: 'local-archive', dependencyClosure: expectedClosure,
    moduleCarrier: 'production', lifecycle: 'failed-start/retry/bootstrap/disable/re-enable',
    statePreserved: true, hostBuildInputs,
    taskPorts: 'real in-memory Host TaskStore, isolated owner and empty thread reader',
    buildProofLimit: 'Direct dist hashes identify this run; source hashes match frozen HEAD. This is not a fresh-build or transitive-build proof.',
    hostProductWrites: false, settingsUI: 'unverified', neutralPorts: 'isolated empty fixture', fullC1: false }));
} finally {
  try { if (instanceId && runtime) await runtime.stop(instanceId, 'test_cleanup'); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
