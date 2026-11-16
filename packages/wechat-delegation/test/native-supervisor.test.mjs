import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeSupervisor } from '../src/native-supervisor.mjs';

const source = Buffer.from(`#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let token='';
const arg = name => process.argv[process.argv.indexOf(name)+1];
// The pinned native component requires a config root even with --data-dir.
const configRoot = process.env.XDG_CONFIG_HOME;
if (!configRoot || !path.isAbsolute(configRoot) || process.env.HOME) {
  process.stderr.write('an isolated absolute configuration root is required');
  process.exit(2);
}
fs.writeFileSync(path.join(configRoot, 'component-started'), 'ready');
process.stdin.on('data', c => token+=c);
process.stdin.on('end', () => {
const [hostname, port] = arg('--listen').split(':');
http.createServer((req,res)=> {
  if(req.headers.authorization!=='Bearer '+token.trim()) {res.statusCode=401;return res.end();}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({serverId:'test-server', dataDir:arg('--data-dir'), pid:process.pid, ownershipGeneration:'owned',
  state:'ready',configRoot,inheritedSensitiveEnvironment:['HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','SSL_CERT_FILE','SSL_CERT_DIR'].filter(key=>process.env[key]!==undefined),version:{product:'agent-wechat',backend:'native',apiVersion:1,version:'test', capabilities:['serve','events','profile-read','text-send','native-login']}}));
}).listen(Number(port),hostname);
});
`);
const actor = () => ({ signal: new AbortController().signal, assertCurrent: async () => {} });
test('owner preparation verifies exact bytes and supervises one child using a private token pipe and isolated data directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-supervisor-'));
  const asset = { fileName: 'wx-test', version: 'test', sha256: createHash('sha256').update(source).digest('hex'), size: source.length,
    url: 'https://github.com/thisnick/agent-wechat/releases/download/test/wx-test' };
  const supervisor = new NativeSupervisor({ dataPath: root, asset, download: async () => source });
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = await supervisor.prepare(actor());
  const status = await client.status();
  assert.equal(status.serverId, 'test-server');
  assert.equal(status.dataDir, join(await realpath(root), 'native-profile'));
  assert.ok(status.configRoot.startsWith(`${await realpath(root)}/`));
  assert.equal(await readFile(join(status.configRoot, 'component-started'), 'utf8'), 'ready');
  assert.equal((await stat(status.configRoot)).mode & 0o777, 0o700);
  assert.equal((await supervisor.prepare(actor())), client);
  assert.ok(supervisor.child.pid > 0);
  assert.ok(!supervisor.child.spawnargs.some(value => value.includes(client.token)));
  await supervisor.stop();
  await assert.rejects(client.status());
});

test('bad integrity or expired owner lifetime starts no executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const supervisor = new NativeSupervisor({ dataPath: root, asset: { fileName: 'wx', sha256: '0'.repeat(64), size: 1 }, download: async () => Buffer.from('x') });
  await assert.rejects(supervisor.prepare(actor()), /integrity/);
  assert.equal(supervisor.child, undefined);
  const control = new AbortController(); control.abort();
  await assert.rejects(supervisor.prepare({ signal: control.signal, assertCurrent: async () => {} }));
  assert.equal(supervisor.child, undefined);
});

test('preparation repairs a corrupt owned component cache without deleting the account profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-repair-'));
  const asset = { fileName: 'wx-test', version: 'test', sha256: createHash('sha256').update(source).digest('hex'), size: source.length };
  await writeFile(join(root, asset.fileName), 'interrupted download');
  await mkdir(join(root, 'native-profile'));
  await writeFile(join(root, 'native-profile', 'retained-history'), 'preserve this account data');
  const supervisor = new NativeSupervisor({ dataPath: root, asset, download: async () => source });
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = await supervisor.prepare(actor());
  assert.equal((await client.status()).serverId, 'test-server');
  assert.equal(await readFile(join(root, 'native-profile', 'retained-history'), 'utf8'), 'preserve this account data');
});

test('the native child receives no owner proxy or CA overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-environment-'));
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = key.includes('PROXY') || key.includes('proxy') ? 'http://127.0.0.1:1' : '/synthetic-owner-certificate';
  const asset = { fileName: 'wx-test', version: 'test', sha256: createHash('sha256').update(source).digest('hex'), size: source.length };
  const supervisor = new NativeSupervisor({ dataPath: root, asset, download: async () => source });
  t.after(async () => {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await supervisor.stop(); await rm(root, { recursive: true, force: true });
  });
  const client = await supervisor.prepare(actor());
  assert.deepEqual((await client.status()).inheritedSensitiveEnvironment, []);
});

test('credential, configuration and instance directories cannot redirect through symlinks', async t => {
  for (const target of ['instance', 'native-profile', 'native-config']) {
    await t.test(target, async t => {
      const root = await mkdtemp(join(tmpdir(), 'wechat-private-directory-'));
      const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
      const instance = join(root, 'instance');
      if (target === 'instance') await symlink(outside, instance);
      else { await mkdir(instance, { mode: 0o700 }); await symlink(outside, join(instance, target)); }
      const asset = { fileName: 'wx-test', version: 'test', sha256: createHash('sha256').update(source).digest('hex'), size: source.length };
      const supervisor = new NativeSupervisor({ dataPath: instance, asset, download: async () => source });
      t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
      await assert.rejects(supervisor.prepare(actor()), /private directory/);
      assert.equal(supervisor.child, undefined);
      await assert.rejects(stat(join(outside, 'component-started')), { code: 'ENOENT' });
    });
  }
});

test('the bundled directory repair component has exact pinned bytes and declares its own provenance', async () => {
  const { nativeAsset, loadBundled } = await import('../src/native-supervisor.mjs');
  const asset = nativeAsset('darwin', 'arm64');
  const binary = await loadBundled(asset, new AbortController().signal);
  assert.equal(binary.length, asset.size);
  assert.equal(createHash('sha256').update(binary).digest('hex'), asset.sha256);
  assert.equal(asset.version, '2.4.1-clowder.2');
  assert.ok(asset.capabilities.includes('current-contact-directory'));
  assert.throws(() => nativeAsset('linux', 'x64'), /暂只提供/);
});

test('the actual bundled component starts in an empty isolated profile and exposes the extended directory route', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-native-bundle-'));
  const supervisor = new NativeSupervisor({ dataPath: root });
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = await supervisor.prepare(actor());
  const status = await client.status();
  assert.equal(status.version.version, '2.4.1-clowder.2');
  assert.ok(status.version.capabilities.includes('current-contact-directory'));
  await client.createAccount('isolated');
  // An unregistered directory route would return 404, whereas this handler
  // recognizes the request and rejects it because the synthetic account has no login.
  const response = await fetch(new URL('v1/accounts/isolated/contact-sync?directory=true', client.base), {
    method: 'POST', headers: { Authorization: `Bearer ${client.token}` },
  });
  assert.notEqual(response.status, 404);
  assert.equal(response.ok, false);
  const account = await client.account('isolated');
  assert.equal(account.authenticated, false);
});

test('the packaged source patch is bound to the component provenance manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/native/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../assets/native/current-directory.patch', import.meta.url));
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.patchSha256);
});
