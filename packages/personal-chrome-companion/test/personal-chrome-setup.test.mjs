import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPersonalChromeSetup } from '../native-host/setup-host.mjs';
import { resolvePersonalChromeHostPaths } from '../native-host/pairing-record.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-chrome-setup-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const homeDirectory = join(root, 'home');
  await Promise.all([mkdir(projectRoot), mkdir(homeDirectory)]);
  return { projectRoot, homeDirectory };
}
const call = (options, operation) => runPersonalChromeSetup({ operation, ...options });

test('fresh owner setup is read-only until install, installs fixed extension identity without exposing secrets', async () => {
  const options = await fixture();
  const absent = await call(options, 'inspect');
  assert.equal(absent.status, 'not_installed');
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  await assert.rejects(lstat(paths.rootDirectory), { code: 'ENOENT' });
  const installed = await call(options, 'install');
  assert.equal(installed.status, 'installed');
  assert.equal(installed.extensionPath, join(paths.rootDirectory, 'extension'));
  const manifest = JSON.parse(await readFile(join(installed.extensionPath, 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  assert.equal(installed.extensionId, id);
  const pairing = JSON.parse(await readFile(paths.pairingRecordPath, 'utf8'));
  assert.equal(pairing.extensionId, id);
  assert.equal(JSON.stringify(installed).includes(pairing.pairingSecret), false);
  assert.equal(Object.hasOwn(installed, 'connected'), false);
  assert.equal((await call(options, 'inspect')).status, 'installed');
  assert.equal((await call(options, 'install')).status, 'installed');
  assert.equal(JSON.parse(await readFile(paths.pairingRecordPath, 'utf8')).pairingSecret, pairing.pairingSecret);
  assert.equal((await call(options, 'uninstall')).status, 'not_installed');
  assert.equal((await call(options, 'inspect')).status, 'not_installed');
});

test('missing launcher is invalid rather than connected and explicit install repairs it', async () => {
  const options = await fixture();
  await call(options, 'install');
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  const pairing = await readFile(paths.pairingRecordPath, 'utf8');
  await rm(paths.launcherPath);
  assert.equal((await call(options, 'inspect')).status, 'invalid_installation');
  assert.equal((await call(options, 'install')).status, 'installed');
  assert.equal(JSON.parse(await readFile(paths.pairingRecordPath, 'utf8')).pairingSecret, JSON.parse(pairing).pairingSecret);
});

test('runner rejects unknown fields, operations and relative Host paths before mutation', async () => {
  const options = await fixture();
  for (const request of [
    { operation: 'shell', ...options },
    { operation: 'install', ...options, extensionId: 'a'.repeat(32) },
    { operation: 'install', ...options, sourceDirectory: '/tmp/elsewhere' },
    { operation: 'install', ...options, projectRoot: '.' },
    { operation: 'install', projectRoot: options.projectRoot },
  ]) await assert.rejects(runPersonalChromeSetup(request), /setup request/);
  await assert.rejects(lstat(resolvePersonalChromeHostPaths(options.projectRoot).rootDirectory), { code: 'ENOENT' });
});

test('linked grant directory is refused without modifying the target', async () => {
  const options = await fixture();
  const outside = join(options.homeDirectory, 'outside');
  await mkdir(outside);
  await symlink(outside, join(options.projectRoot, '.cat-cafe'));
  const result = await call(options, 'install');
  assert.equal(result.status, 'invalid_installation');
  await assert.rejects(lstat(join(outside, 'plugin-host')), { code: 'ENOENT' });
});

test('malformed pairing never silently rotates identity or leaks raw file contents', async () => {
  const options = await fixture();
  await call(options, 'install');
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  await writeFile(paths.pairingRecordPath, 'secret-marker invalid JSON');
  const failed = await call(options, 'install');
  assert.equal(failed.status, 'invalid_installation');
  assert.equal(JSON.stringify(failed).includes('secret-marker'), false);
  assert.equal(await readFile(paths.pairingRecordPath, 'utf8'), 'secret-marker invalid JSON');
});

test('another project registration is a conflict, never silently taken over or uninstalled', async () => {
  const first = await fixture();
  await call(first, 'install');
  const second = await fixture();
  const conflict = { ...second, homeDirectory: first.homeDirectory };
  for (const operation of ['inspect', 'install', 'uninstall']) {
    assert.equal((await call(conflict, operation)).errorCode, 'REGISTRATION_CONFLICT');
  }
  assert.equal((await call(first, 'inspect')).status, 'installed');
  await assert.rejects(lstat(resolvePersonalChromeHostPaths(second.projectRoot).rootDirectory), { code: 'ENOENT' });
});

test('extension loss is not a complete installation and explicit retry restores it', async () => {
  const options = await fixture();
  const installed = await call(options, 'install');
  await rm(installed.extensionPath, { recursive: true });
  assert.equal((await call(options, 'inspect')).status, 'invalid_installation');
  assert.equal((await call(options, 'install')).status, 'installed');
});

function command(options, action, extra = []) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../native-host/setup-host.mjs', import.meta.url)),
    action, '--json', '--project-root', options.projectRoot, '--home', options.homeDirectory,
    '--node', process.execPath, ...extra], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: options.homeDirectory } });
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return { exit: result.status, value: JSON.parse(result.stdout) };
}

test('actual fixed runner speaks one bounded protocol document, never a credential or connected claim', async () => {
  const options = await fixture();
  const absent = command(options, 'inspect');
  assert.equal(absent.exit, 0);
  assert.deepEqual(Object.keys(absent.value).sort(), ['protocolVersion', 'ok', 'action', 'installed',
    'extensionPath', 'extensionId', 'browserAction', 'restartRequired'].sort());
  assert.equal(absent.value.installed, false);
  assert.equal(absent.value.extensionPath, null);
  const install = command(options, 'install');
  assert.equal(install.exit, 0);
  assert.equal(install.value.installed, true);
  assert.equal(install.value.browserAction, 'load-unpacked');
  assert.equal(install.value.restartRequired, true);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  const pairing = JSON.parse(await readFile(paths.pairingRecordPath, 'utf8'));
  assert.equal(JSON.stringify(install.value).includes(pairing.pairingSecret), false);
  assert.deepEqual(command(options, 'inspect').value, { ...install.value, action: 'inspect' });
  assert.deepEqual(command(options, 'install', ['--arbitrary', 'command']), {
    exit: 0, value: { protocolVersion: 1, ok: false, action: 'install', code: 'INVALID_REQUEST' },
  });
});

test('active helper blocks product install and uninstall without stopping it', async () => {
  const options = await fixture();
  await call(options, 'install');
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  await writeFile(paths.socketPath, 'active-socket-marker');
  try {
    for (const operation of ['install', 'uninstall']) {
      assert.equal(command(options, operation).value.code, 'HELPER_ACTIVE');
    }
    assert.equal(await readFile(paths.socketPath, 'utf8'), 'active-socket-marker');
  } finally { await rm(paths.socketPath); }
});

test('concurrent product setup for two projects cannot steal the user registration', async () => {
  const first = await fixture();
  const second = { ...await fixture(), homeDirectory: first.homeDirectory };
  const results = await Promise.all([call(first, 'install'), call(second, 'install')]);
  assert.equal(results.filter(result => result.status === 'installed').length, 1);
  const failed = results.find(result => result.status !== 'installed');
  assert.ok(['INSTALLATION_BUSY', 'REGISTRATION_CONFLICT'].includes(failed.errorCode));
  const winner = results[0].status === 'installed' ? first : second;
  assert.equal((await call(winner, 'inspect')).status, 'installed');
});

test('setup uninstall preserves authorization and durable user data while removing only registration and identity', async () => {
  const options = await fixture();
  await call(options, 'install');
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  const retained = [paths.conversationBindingPath, paths.ledgerPath];
  for (const file of retained) await writeFile(file, 'preserved-owner-data');
  assert.equal(command(options, 'uninstall').value.installed, false);
  for (const file of retained) assert.equal(await readFile(file, 'utf8'), 'preserved-owner-data');
  for (const file of [paths.pairingRecordPath, paths.launcherPath]) await assert.rejects(lstat(file), { code: 'ENOENT' });
  assert.equal((await lstat(join(paths.rootDirectory, 'extension'))).isDirectory(), true);
});
