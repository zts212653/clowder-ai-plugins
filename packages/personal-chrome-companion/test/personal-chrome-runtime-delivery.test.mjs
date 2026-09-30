import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installNativeHost } from '../native-host/install-host.mjs';
import { acquireProcessLease } from '../native-host/native-socket-lease.mjs';
import { resolvePersonalChromeHostPaths } from '../native-host/pairing-record.mjs';
import { prepareRuntimeDelivery } from '../src/runtime-delivery.js';
import { extensionFiles } from '../src/extension-delivery.js';
import { createConversationHostOperations } from '../src/conversation-host.js';
import { createAuthorizationOperations } from '../src/plugin-entrypoint.js';
import { PERSONAL_CHROME_EXTENSION_REVISION, PERSONAL_CHROME_PAGE_ADAPTER_REVISION } from '../src/protocol.js';
const require = createRequire(import.meta.url);
const contractRequire = createRequire(import.meta.resolve('@clowder-ai/plugin-contract'));
const Ajv = contractRequire('ajv/dist/2020');
const ajv = new Ajv({ allErrors: true, strict: false });
contractRequire('ajv-formats')(ajv);
for (const name of ['plugin-metadata', 'signals', 'messaging', 'manifest']) {
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@clowder-ai/plugin-contract/schemas/${name}`), 'utf8')));
}
const schema = JSON.parse(readFileSync(require.resolve('@clowder-ai/plugin-contract/schemas/manifest'), 'utf8'));
const validateStatus = ajv.getSchema(`${schema.$id}#/$defs/OperationActionResult`);

async function fixture(t, installed = true) {
  const root = await mkdtemp(join(tmpdir(), 'p2d-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolvePersonalChromeHostPaths(join(root, 'project'));
  const sources = { extensionDirectory: join(root, 'extension-source'), nativeHostDirectory: join(root, 'helper-source') };
  await cp(new URL('../extension/', import.meta.url), sources.extensionDirectory, { recursive: true });
  await cp(new URL('../native-host/', import.meta.url), sources.nativeHostDirectory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(sources.extensionDirectory, 'manifest.json'), 'utf8'));
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const install = { projectRoot: join(root, 'project'), homeDirectory: join(root, 'fake-home'),
    userDataDirectory: join(root, 'fake-chrome'), sourceDirectory: sources.nativeHostDirectory, extensionId, platform: 'darwin' };
  if (installed) await installNativeHost(install);
  return { root, paths, sources, extensionId, install,
    prepare: () => prepareRuntimeDelivery(paths.rootDirectory, sources) };
}
async function fingerprint(root) {
  const entries = [];
  for (const name of (await readdir(root, { recursive: true }).catch(() => [])).sort()) {
    const metadata = await lstat(join(root, name));
    entries.push([name, metadata.mode, metadata.isFile() ? (await readFile(join(root, name))).toString('base64') : null]);
  }
  return entries;
}
async function revisions(f) {
  return { helper: JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8')).artifactDigest,
    extension: PERSONAL_CHROME_EXTENSION_REVISION, pageAdapter: PERSONAL_CHROME_PAGE_ADAPTER_REVISION };
}

for (const target of ['launcherPath', 'pairingRecordPath']) {
  test(`helper ${target} activation failure restores the whole generation under one lease`, async (t) => {
    const f = await fixture(t);
    await (await f.prepare()).dispose();
    const extensionFile = join(f.paths.rootDirectory, 'extension/service-worker.js');
    const before = { extension: await readFile(extensionFile), launcher: await readFile(f.paths.launcherPath),
      pairing: await readFile(f.paths.pairingRecordPath) };
    await writeFile(join(f.sources.extensionDirectory, 'service-worker.js'), '// next extension generation');
    await writeFile(join(f.sources.nativeHostDirectory, 'native-host-cli.mjs'), '// next helper generation');
    const originalRename = fsPromises.rename;
    let injected = false;
    let checkedLease = false;
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      if (to === extensionFile.replace('/service-worker.js', '') && !checkedLease) {
        checkedLease = true;
        await assert.rejects(installNativeHost(f.install), /already has a live owner/);
      }
      if (to === f.paths[target] && !injected) {
        injected = true;
        await assert.rejects(installNativeHost(f.install), /already has a live owner/);
        throw Object.assign(new Error('injected helper commit failure'), { code: 'EACCES' });
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const delivery = await f.prepare();
    await delivery.dispose();
    assert.equal(injected && checkedLease, true);
    assert.equal(delivery.status().failure, 'PERMISSION_DENIED');
    assert.deepEqual(await readFile(extensionFile), before.extension);
    assert.deepEqual(await readFile(f.paths.launcherPath), before.launcher);
    assert.deepEqual(await readFile(f.paths.pairingRecordPath), before.pairing);
  });
}

test('stop persists accepted STALE after an in-flight match and rejects new observations', async (t) => {
  const f = await fixture(t);
  const delivery = await f.prepare();
  const currentRevisions = await revisions(f);
  const recordPath = join(f.paths.rootDirectory, 'delivery-reload.json');
  let entered, release;
  const entering = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const originalRename = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === recordPath) { entered(); await gate; }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const matching = delivery.observe(currentRevisions);
  await entering;
  const stale = delivery.observe(undefined, 'STALE_EXTENSION');
  const stopping = delivery.dispose();
  const afterStop = delivery.observe(currentRevisions);
  release();
  await Promise.all([matching, stale, stopping, afterStop]);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).reloadRequired, true);
  const restarted = await f.prepare();
  assert.equal(restarted.status().reloadRequired, true);
  await restarted.dispose();
});

test('places all extension bytes before helper install, once, without writes to fake home/Chrome', async (t) => {
  const f = await fixture(t, false);
  const delivery = await f.prepare();
  assert.equal(delivery.status().failure, undefined);
  assert.equal(delivery.status().reloadRequired, true);
  const copy = join(f.paths.rootDirectory, 'extension');
  assert.deepEqual(await extensionFiles(copy), await extensionFiles(f.sources.extensionDirectory));
  const inode = (await lstat(copy)).ino;
  const again = await f.prepare();
  assert.equal((await lstat(copy)).ino, inode, 'unchanged digest does not replace directory');
  assert.equal(again.status().reloadRequired, true, 'reload survives restart');
  await assert.rejects(readFile(f.paths.pairingRecordPath), { code: 'ENOENT' });
  assert.deepEqual(await fingerprint(f.install.homeDirectory), []);
  assert.deepEqual(await fingerprint(f.install.userDataDirectory), []);
});

test('N to N+1 and back to N switch extension/helper/launcher by digest with stable key, secret, socket and external manifest', async (t) => {
  const f = await fixture(t);
  const outside = await fingerprint(f.install.userDataDirectory);
  const record = JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'));
  const extensionFile = join(f.sources.extensionDirectory, 'service-worker.js');
  const helperFile = join(f.sources.nativeHostDirectory, 'native-host-cli.mjs');
  const extensionBytes = await readFile(extensionFile);
  const helperBytes = await readFile(helperFile);
  let delivery = await f.prepare();
  await delivery.observe(await revisions(f));
  assert.equal(delivery.status().reloadRequired, false);
  for (const suffix of ['\n// fixture N+1\n', '']) {
    await writeFile(extensionFile, Buffer.concat([extensionBytes, Buffer.from(suffix)]));
    await writeFile(helperFile, Buffer.concat([helperBytes, Buffer.from(suffix)]));
    delivery = await f.prepare();
    assert.equal(delivery.status().failure, undefined);
    assert.match(delivery.label(), /Reload/);
    const installed = JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'));
    for (const key of ['pairingSecret', 'socketPath', 'extensionId', 'installedAt', 'ledgerPath']) assert.equal(installed[key], record[key]);
    const copied = JSON.parse(await readFile(join(f.paths.rootDirectory, 'extension/manifest.json'), 'utf8'));
    const actualId = createHash('sha256').update(Buffer.from(copied.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    assert.equal(actualId, installed.extensionId);
    assert.deepEqual(await extensionFiles(join(f.paths.rootDirectory, 'extension')), await extensionFiles(f.sources.extensionDirectory));
    assert.match(await readFile(f.paths.launcherPath, 'utf8'), new RegExp(installed.artifactDigest.slice(7)));
    assert.deepEqual(await fingerprint(f.install.userDataDirectory), outside);
    assert.deepEqual(await fingerprint(f.install.homeDirectory), []);
    await delivery.observe(await revisions(f));
    assert.equal(delivery.status().reloadRequired, false);
    assert.equal((await f.prepare()).status().reloadRequired, false);
  }
  assert.equal(JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8')).artifactDigest, record.artifactDigest);
});

test('installation lease prevents extension replacement; failure is safe status data, not a thrown start', async (t) => {
  const f = await fixture(t);
  const lease = await acquireProcessLease(join(f.paths.rootDirectory, 'install'), { label: 'native host installation' });
  try {
    const delivery = await f.prepare();
    assert.equal(delivery.status().failure, 'INSTALLATION_BUSY');
    await assert.rejects(readFile(join(f.paths.rootDirectory, 'extension/manifest.json')), { code: 'ENOENT' });
    const status = await createAuthorizationOperations({ authorizationPath: f.paths.conversationBindingPath, delivery }).status();
    assert.equal(validateStatus(status), true, JSON.stringify(validateStatus.errors));
    assert.match(status.label, /INSTALLATION_BUSY/);
  } finally { await lease.release(); }
  assert.equal((await f.prepare()).status().failure, undefined);
});

test('extension destination symlinks cannot write outside the grant and errors expose no contents', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external');
  await mkdir(external);
  await writeFile(join(external, 'secret.txt'), 'private marker');
  await symlink(external, join(f.paths.rootDirectory, 'extension'));
  const before = await fingerprint(external);
  const delivery = await f.prepare();
  assert.equal(delivery.status().failure, 'DELIVERY_IO');
  assert.doesNotMatch(delivery.label(), /private marker|secret.txt/);
  assert.deepEqual(await fingerprint(external), before);
});

test('only correlated matching revision contact clears reload; stale append/probe sets it again', async (t) => {
  const f = await fixture(t);
  const delivery = await f.prepare();
  const pairing = JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'));
  let mode = 'missing-revisions';
  const server = createServer((socket) => {
    socket.once('data', (bytes) => {
      const { request } = JSON.parse(bytes.toString());
      const observedRevisions = request.expectedRevisions;
      if (request.kind === 'append_message') {
        socket.end(JSON.stringify({ v: 2, kind: 'append_result', requestId: request.requestId,
          idempotencyKey: request.idempotencyKey, status: 'failed', errorCode: 'STALE_EXTENSION', observedRevisions }) + '\n');
      } else socket.end(JSON.stringify({ v: 2, kind: 'health_result',
        requestId: mode === 'uncorrelated' ? 'wrong-request' : request.requestId,
        status: mode === 'stale' ? 'stale_adapter' : 'ready',
        ...(mode === 'missing-revisions' ? {} : { observedRevisions }),
        ...(mode === 'stale' ? { errorCode: 'STALE_HELPER' } : {}),
      }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(pairing.socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const operations = createConversationHostOperations({ dataDirectory: f.paths.rootDirectory, onRevisionContact: delivery.observe });
  t.after(() => operations.dispose());
  for (mode of ['missing-revisions', 'uncorrelated']) {
    await operations.probe();
    assert.equal(delivery.status().reloadRequired, true);
  }
  mode = 'current';
  assert.equal((await operations.probe()).ok, true);
  assert.equal(delivery.status().reloadRequired, false);
  const append = await operations.appendMessage({ conversationId: 'conversation-1', text: 'test', idempotencyKey: 'delivery-1' });
  assert.equal(append.errorCode, 'STALE_ADAPTER');
  assert.equal(delivery.status().reloadRequired, true);
  await operations.probe();
  assert.equal(delivery.status().reloadRequired, false);
  mode = 'stale';
  assert.equal((await operations.probe()).ok, false);
  assert.equal(delivery.status().reloadRequired, true);
  await delivery.dispose();
  mode = 'current';
  await operations.probe();
  assert.equal(delivery.status().reloadRequired, true, 'stopped delivery ignores late receipt');
});

test('stop waits for in-flight delivery bookkeeping and no write completes after it returns', async (t) => {
  const f = await fixture(t);
  const delivery = await f.prepare();
  const currentRevisions = await revisions(f);
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const originalRename = fsPromises.rename;
  const recordPath = join(f.paths.rootDirectory, 'delivery-reload.json');
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === recordPath) { entered(); await gate; }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const observation = delivery.observe(currentRevisions);
  await enteredPromise;
  let stopped = false;
  const stopping = Promise.resolve(delivery.dispose()).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal(stopped, false, 'stop must drain its active write'); }
  finally { release(); await observation; await stopping; }
  const bytes = await readFile(recordPath);
  await delivery.observe(undefined, 'STALE_EXTENSION');
  assert.deepEqual(await readFile(recordPath), bytes);
});

test('a stale reply arriving during a matching reply write cannot lose the reload reminder', async (t) => {
  const f = await fixture(t);
  const delivery = await f.prepare();
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const originalRename = fsPromises.rename;
  const recordPath = join(f.paths.rootDirectory, 'delivery-reload.json');
  let first = true;
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === recordPath && first) { first = false; entered(); await gate; }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const matched = delivery.observe(await revisions(f));
  await enteredPromise;
  const stale = delivery.observe(undefined, 'STALE_EXTENSION');
  release();
  await Promise.all([matched, stale]);
  assert.equal(delivery.status().reloadRequired, true);
  assert.equal((await f.prepare()).status().reloadRequired, true);
});

test('a failed activation rename restores the previous complete extension', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const copy = join(f.paths.rootDirectory, 'extension');
  const before = await extensionFiles(copy);
  await writeFile(join(f.sources.extensionDirectory, 'service-worker.js'), '// new generation fixture');
  const originalRename = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === copy && !from.includes('.extension-previous-')) throw Object.assign(new Error('injected'), { code: 'EACCES' });
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const delivery = await f.prepare();
  assert.equal(delivery.status().failure, 'PERMISSION_DENIED');
  assert.deepEqual(await extensionFiles(copy), before);
  assert.equal((await readdir(f.paths.rootDirectory)).some((name) => name.startsWith('.extension-')), false);
});

test('fresh-process delivery with a fake HOME cannot create or alter native registration outside its data directory', async (t) => {
  const f = await fixture(t);
  const before = await fingerprint(f.install.userDataDirectory);
  await writeFile(join(f.sources.nativeHostDirectory, 'native-host-cli.mjs'), '// new helper generation fixture');
  const moduleUrl = new URL('../src/runtime-delivery.ts', import.meta.url).href;
  const code = `import { prepareRuntimeDelivery } from ${JSON.stringify(moduleUrl)};
    const delivery = await prepareRuntimeDelivery(process.argv[1], JSON.parse(process.argv[2]));
    if (delivery.status().failure) throw new Error(delivery.status().failure);
    await delivery.dispose();`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code,
    f.paths.rootDirectory, JSON.stringify(f.sources)], {
    env: { ...process.env, HOME: f.install.homeDirectory, XDG_CONFIG_HOME: join(f.install.homeDirectory, '.config') },
  });
  assert.deepEqual(await fingerprint(f.install.homeDirectory), []);
  assert.deepEqual(await fingerprint(f.install.userDataDirectory), before);
});
