import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, lstat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPersonalChromeSetup } from '../native-host/setup-host.mjs';
import { resolvePersonalChromeHostPaths } from '../native-host/pairing-record.mjs';
import { acquireSocketLease, acquireInactiveSocketLease } from '../native-host/native-socket-lease.mjs';
import { uninstallNativeHost } from '../native-host/install-host.mjs';
import { manifestLocation } from '../native-host/native-host-install-contract.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p2f-sol-boundary-'));
  const projectRoot = join(root, 'project');
  const homeDirectory = join(root, 'home');
  await mkdir(projectRoot); await mkdir(homeDirectory);
  return { root, projectRoot, homeDirectory };
}

for (const operation of ['install', 'uninstall']) test(`${operation} refuses a helper that starts before activation`, async () => {
  const f = await fixture();
  const paths = resolvePersonalChromeHostPaths(f.projectRoot);
  const { manifestPath } = manifestLocation({ platform: process.platform, homeDirectory: f.homeDirectory });
  let socketLease;
  let server;
  let interleaved = false;
  const originalLink = fs.promises.link;
  try {
    const request = { projectRoot: f.projectRoot, homeDirectory: f.homeDirectory, operation: 'install' };
    assert.equal((await runPersonalChromeSetup(request)).status, 'installed');
    request.operation = operation;
    if (operation === 'install') await unlink(paths.launcherPath); // Existing installation needs repair.
    const manifestBefore = await readFile(manifestPath);
    const pairingBefore = await readFile(paths.pairingRecordPath);
    fs.promises.link = async (source, destination) => {
      const result = await originalLink(source, destination);
      if (destination === `${manifestPath}.setup.owner`) {
        interleaved = true;
        socketLease = await acquireSocketLease(paths.socketPath);
        server = createServer(socket => socket.end());
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.socketPath, resolve); });
      }
      return result;
    };
    syncBuiltinESMExports();
    const result = await runPersonalChromeSetup(request);
    const launcherRestored = !!(await lstat(paths.launcherPath).catch(() => undefined));
    console.log(JSON.stringify({ scenario: 'helper-arrives-during-setup', interleaved, status: result.status,
      errorCode: result.errorCode ?? null, launcherRestored, helperOwnerPresent: !!socketLease }));
    assert.equal(interleaved, true);
    assert.equal(result.errorCode, 'HELPER_ACTIVE', 'must not activate while a helper owns the socket');
    assert.equal(launcherRestored, operation === 'uninstall');
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    assert.deepEqual(await readFile(paths.pairingRecordPath), pairingBefore);
  } finally {
    fs.promises.link = originalLink; syncBuiltinESMExports();
    if (server) await new Promise(resolve => server.close(resolve));
    await socketLease?.release();
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const operation of ['install', 'uninstall']) test(`${operation} holds the helper fence throughout activation`, async () => {
  const f = await fixture();
  const paths = resolvePersonalChromeHostPaths(f.projectRoot);
  const originalLink = fs.promises.link;
  let attemptedStartup = false;
  try {
    const options = { projectRoot: f.projectRoot, homeDirectory: f.homeDirectory };
    assert.equal((await runPersonalChromeSetup({ ...options, operation: 'install' })).status, 'installed');
    fs.promises.link = async (source, destination) => {
      const result = await originalLink(source, destination);
      if (destination === join(paths.rootDirectory, 'install.owner')) {
        attemptedStartup = true;
        await assert.rejects(async () => {
          const helperLease = await acquireSocketLease(paths.socketPath);
          await helperLease.release();
        }, /socket already has a live owner/);
      }
      return result;
    };
    syncBuiltinESMExports();
    const result = await runPersonalChromeSetup({ ...options, operation });
    assert.equal(attemptedStartup, true);
    assert.equal(result.status, operation === 'install' ? 'installed' : 'not_installed');
    const after = await acquireSocketLease(paths.socketPath);
    await after.release(); // Setup releases its exclusion on completion.
  } finally {
    fs.promises.link = originalLink; syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('nested uninstall rejects forged, released, wrong-project and ordinary helper leases', async () => {
  const f = await fixture();
  const other = await fixture();
  const options = { projectRoot: f.projectRoot, homeDirectory: f.homeDirectory };
  const paths = resolvePersonalChromeHostPaths(f.projectRoot);
  const foreign = await acquireInactiveSocketLease(resolvePersonalChromeHostPaths(other.projectRoot).socketPath);
  let ordinary;
  try {
    assert.equal((await runPersonalChromeSetup({ ...options, operation: 'install' })).status, 'installed');
    const released = await acquireInactiveSocketLease(paths.socketPath);
    await released.release();
    ordinary = await acquireSocketLease(paths.socketPath);
    for (const socketLease of [{ release: async () => {} }, released, foreign, ordinary]) {
      await assert.rejects(uninstallNativeHost({ ...options, socketLease }), /invalid held socket lease/);
    }
    assert.equal((await runPersonalChromeSetup({ ...options, operation: 'inspect' })).status, 'installed');
  } finally {
    await ordinary?.release(); await foreign.release();
    await rm(f.root, { recursive: true, force: true });
    await rm(other.root, { recursive: true, force: true });
  }
});

test('failed setup releases the helper exclusion without replacing corrupt pairing', async () => {
  const f = await fixture();
  const paths = resolvePersonalChromeHostPaths(f.projectRoot);
  const options = { projectRoot: f.projectRoot, homeDirectory: f.homeDirectory, operation: 'install' };
  try {
    assert.equal((await runPersonalChromeSetup(options)).status, 'installed');
    await writeFile(paths.pairingRecordPath, 'invalid-preserved-pairing');
    assert.equal((await runPersonalChromeSetup(options)).errorCode, 'INVALID_INSTALLATION');
    const helperLease = await acquireSocketLease(paths.socketPath);
    await helperLease.release();
    assert.equal(await readFile(paths.pairingRecordPath, 'utf8'), 'invalid-preserved-pairing');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('uninstall removes an owned browser registration even if project data was lost', async () => {
  const f = await fixture();
  try {
    const request = { projectRoot: f.projectRoot, homeDirectory: f.homeDirectory };
    assert.equal((await runPersonalChromeSetup({ ...request, operation: 'install' })).status, 'installed');
    const paths = resolvePersonalChromeHostPaths(f.projectRoot);
    const { manifestPath } = manifestLocation({ platform: process.platform, homeDirectory: f.homeDirectory });
    const before = await readFile(manifestPath);
    assert.ok(paths.rootDirectory.startsWith(`${f.root}/`));
    await rm(paths.rootDirectory, { recursive: true });
    const result = await runPersonalChromeSetup({ ...request, operation: 'uninstall' });
    const registrationRemains = !!(await lstat(manifestPath).catch(() => undefined));
    console.log(JSON.stringify({ scenario: 'orphan-registration-uninstall', status: result.status,
      registrationRemains, registrationUnchanged: registrationRemains && (await readFile(manifestPath)).equals(before) }));
    assert.equal(result.status, 'not_installed');
    assert.equal(registrationRemains, false, 'successful uninstall must remove its owned HOME registration');
    await assert.rejects(lstat(paths.rootDirectory), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
