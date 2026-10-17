import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [hostRoot, candidate] = process.argv.slice(2);
assert.ok(hostRoot && candidate, 'explicit frozen Host root and materialized local directory are required');
const expectedHead = '93fee4342cf7296e5ec8def9d9cc8ae2754be49f';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(), expectedHead);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' }).trim(), '');
const temporary = await mkdtemp(join(tmpdir(), 'collective-host-admission-'));
// Logging must be isolated before the transitive Host imports initialize it.
process.env.LOG_DIR = join(temporary, 'logs');
process.env.NODE_ENV = 'test';
const domainRoot = join(hostRoot, 'packages/api/dist/domains/plugin');
const hostBuildInputs = {};
const load = async path => {
  const absolutePath = join(domainRoot, path);
  const sourcePath = `packages/api/src/domains/plugin/${path.replace(/\.js$/, '.ts')}`;
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
const { LocalPluginPackageAdmission } = await load('manager/local-package-admission.js');
const { FilePluginInventoryStore } = await load('host-inventory/stores.js');
const { HostInventoryControlPlane } = await load('host-inventory/control-plane.js');
const { FilesystemVerifiedPluginPackageLocator } = await load('external-runtime/filesystem-package-locator.js');
const { ModulePluginRuntime } = await load('builtin-runtime/carriers/module-plugin-runtime.js');
const packagesRoot = join(temporary, 'packages');
const inventoryPath = join(temporary, 'inventory.json');
const inventory = new FilePluginInventoryStore(inventoryPath);
const control = new HostInventoryControlPlane(inventory);
let port = 0;
const configuration = { async readConfig(_id, key) { return key === 'servicePort' ? port : undefined; }, async readSecret() { return undefined; } };
const runtime = new ModulePluginRuntime({ packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
  configuration, dataDirectoryParent: join(temporary, 'data'), log() {},
});
let instanceId;
async function listen(probe, value = 0) {
  await new Promise((resolve, reject) => {
    probe.once('error', reject); probe.listen(value, '127.0.0.1', resolve);
  });
  return probe.address().port;
}
async function close(probe) {
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
try {
  const admission = new LocalPluginPackageAdmission({ packagesRoot, inventory: control,
    grantPolicy: () => ['plugin.config.read', 'data.directory'],
  });
  const installed = await admission.install({ kind: 'local-directory', path: candidate });
  instanceId = installed.pluginInstanceId;
  const snapshot = await new FilePluginInventoryStore(inventoryPath).snapshot();
  assert.equal(snapshot.instances.length, 1, 'actual inventory survives reload');
  const record = snapshot.packages[0];
  assert.equal(record.provenance.kind, 'local-directory');
  assert.equal(record.provenance.dependencyClosure, 'shipped');
  assert.equal(record.pluginId, 'official.collective-connector');
  assert.equal(runtime.claims(record), true);
  const grants = snapshot.grants[0].effectiveGrants;
  const probe = createServer(); port = await listen(probe); await close(probe);
  const brokenLink = join(temporary, 'data/collective/service/owner-bootstrap.url');
  await mkdir(brokenLink, { recursive: true });
  await assert.rejects(runtime.start(instanceId, record, grants), /EISDIR|EEXIST|ENOTEMPTY/);
  assert.equal(runtime.actions(instanceId), undefined, 'failed Host activation publishes no actions');
  const released = createServer(); await listen(released, port); await close(released);
  await rm(brokenLink, { recursive: true });
  await runtime.start(instanceId, record, grants);
  const status = (await runtime.invoke(instanceId, 'collective.service.status', {})).data;
  assert.equal((await fetch(status.url + '/api/health')).status, 200);
  const bootstrapLink = new URL((await readFile(brokenLink, 'utf8')).trim());
  const secret = new URLSearchParams(bootstrapLink.hash.slice(1)).get('bootstrap');
  const claim = await fetch(status.url + '/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, displayName: 'Host admitted isolated owner' }),
  });
  assert.equal(claim.status, 201, 'Host retry preserves unclaimed credential');
  await runtime.stop(instanceId, 'disabled');
  await assert.rejects(runtime.invoke(instanceId, 'collective.service.status', {}));
  const disabled = createServer(); await listen(disabled, port); await close(disabled);
  await runtime.start(instanceId, record, grants);
  const resumed = (await runtime.invoke(instanceId, 'collective.service.status', {})).data;
  assert.equal(resumed.serviceInstanceId, status.serviceInstanceId);
  assert.equal(resumed.bootstrapNeeded, false);
  console.log(JSON.stringify({ result: 'PASS', hostHead: expectedHead, localDirectoryAdmission: 'production',
    inventory: 'file/reloaded', provenance: 'local-directory', dependencyClosure: 'shipped',
    moduleCarrier: 'production', lifecycle: 'failed-start/retry/bootstrap/disable/re-enable',
    statePreserved: true, hostBuildInputs,
    buildProofLimit: 'Direct dist hashes identify this run; source hashes match frozen HEAD. This is not a fresh-build or transitive-build proof.',
    hostProductWrites: false, settingsUI: 'unverified', fullC1: false }));
} finally {
  if (instanceId) await runtime.stop(instanceId, 'test_cleanup');
  await rm(temporary, { recursive: true, force: true });
}
