import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as installer from '../native-host/install-host.mjs';
import { resolvePersonalChromeHostPaths, writePersonalChromePairingRecordAtomic } from '../native-host/pairing-record.mjs';
import { acquireProcessLease } from '../native-host/native-socket-lease.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'p2d-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const homeDirectory = join(root, 'home');
  const userDataDirectory = join(root, 'chrome');
  const sourceDirectory = join(root, 'source');
  await cp(new URL('../native-host/', import.meta.url), sourceDirectory, { recursive: true });
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const install = { projectRoot, homeDirectory, userDataDirectory, sourceDirectory, extensionId, platform: 'darwin' };
  return { root, sourceDirectory, install, paths: resolvePersonalChromeHostPaths(projectRoot) };
}
async function tree(root) {
  const result = {};
  for (const name of await readdir(root, { recursive: true }).catch(() => [])) {
    const path = join(root, name);
    if ((await lstat(path)).isFile()) result[name] = (await readFile(path)).toString('base64');
  }
  return result;
}

test('republish skips an uninstalled helper and does not install or register it', async (t) => {
  const f = await fixture(t);
  assert.equal((await installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory })).operation, 'not_installed');
  assert.deepEqual(await tree(f.install.homeDirectory), {});
  await assert.rejects(readFile(f.paths.pairingRecordPath), { code: 'ENOENT' });
});

test('republish updates and rolls back by digest while preserving identity and external registration', async (t) => {
  const f = await fixture(t);
  await installer.installNativeHost(f.install);
  const original = JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'));
  const launcher = await readFile(f.paths.launcherPath, 'utf8');
  const outside = await tree(f.install.userDataDirectory);
  const sourceFile = join(f.sourceDirectory, 'native-host-cli.mjs');
  const bytes = await readFile(sourceFile);
  assert.equal((await installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory, sourceDirectory: f.sourceDirectory })).operation, 'unchanged');
  for (const next of [Buffer.concat([bytes, Buffer.from('\n// fixture generation N+1\n')]), bytes]) {
    await writeFile(sourceFile, next);
    const result = await installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory, sourceDirectory: f.sourceDirectory });
    assert.equal(result.operation, 'republished');
    const record = JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'));
    for (const key of ['pairingSecret', 'socketPath', 'extensionId', 'ledgerPath', 'installedAt']) assert.equal(record[key], original[key]);
    assert.match(await readFile(f.paths.launcherPath, 'utf8'), new RegExp(record.artifactDigest.slice(7)));
    assert.deepEqual(await tree(f.install.userDataDirectory), outside);
    assert.deepEqual(await tree(f.install.homeDirectory), {});
  }
  assert.equal((JSON.parse(await readFile(f.paths.pairingRecordPath, 'utf8'))).artifactDigest, original.artifactDigest);
  assert.equal(await readFile(f.paths.launcherPath, 'utf8'), launcher);
});

test('republish restores launcher and pairing even if the pairing write committed before throwing', async (t) => {
  const f = await fixture(t);
  await installer.installNativeHost(f.install);
  const before = [await readFile(f.paths.launcherPath), await readFile(f.paths.pairingRecordPath)];
  await writeFile(join(f.sourceDirectory, 'native-host-cli.mjs'), '// fixture N+1\n');
  await assert.rejects(installer.republishNativeHost({
    dataDirectory: f.paths.rootDirectory, sourceDirectory: f.sourceDirectory,
    writePairingRecord: async (...args) => { await writePersonalChromePairingRecordAtomic(...args); throw new Error('injected commit fault'); },
  }), /injected commit fault/);
  assert.deepEqual(await readFile(f.paths.launcherPath), before[0]);
  assert.deepEqual(await readFile(f.paths.pairingRecordPath), before[1]);
});

test('republish shares the explicit installer lease and refuses a symlink out of the data directory', async (t) => {
  const f = await fixture(t);
  await installer.installNativeHost(f.install);
  const lease = await acquireProcessLease(join(f.paths.rootDirectory, 'install'), { label: 'native host installation' });
  try {
    await assert.rejects(installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory }), /live owner/);
  } finally { await lease.release(); }
  await rm(f.paths.artifactsDirectory, { recursive: true });
  await symlink(f.sourceDirectory, f.paths.artifactsDirectory);
  await assert.rejects(installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory }), /directory/);
});

test('an actual in-flight republish holds the installer lease until its pairing commit completes', async (t) => {
  const f = await fixture(t);
  await installer.installNativeHost(f.install);
  await writeFile(join(f.sourceDirectory, 'native-host-cli.mjs'), '// fixture next generation');
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const publishing = installer.republishNativeHost({ dataDirectory: f.paths.rootDirectory, sourceDirectory: f.sourceDirectory,
    writePairingRecord: async (...args) => { entered(); await gate; return writePersonalChromePairingRecordAtomic(...args); },
  });
  await enteredPromise;
  try { await assert.rejects(installer.installNativeHost(f.install), /installation already has a live owner/); }
  finally { release(); }
  assert.equal((await publishing).operation, 'republished');
  assert.equal((await installer.installNativeHost(f.install)).operation, 'unchanged');
});
