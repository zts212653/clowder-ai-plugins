import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeSupervisor } from '../src/native-supervisor.mjs';

const source = Buffer.from(`#!/usr/bin/env node
const http = require('node:http');
let token='';
const arg = name => process.argv[process.argv.indexOf(name)+1];
process.stdin.on('data', c => token+=c);
process.stdin.on('end', () => {
const [hostname, port] = arg('--listen').split(':');
http.createServer((req,res)=> {
  if(req.headers.authorization!=='Bearer '+token.trim()) {res.statusCode=401;return res.end();}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({serverId:'test-server', dataDir:arg('--data-dir'), pid:process.pid, ownershipGeneration:'owned',
  state:'ready',version:{product:'agent-wechat',backend:'native',apiVersion:1,version:'test', capabilities:['serve','events','profile-read','text-send','native-login']}}));
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
