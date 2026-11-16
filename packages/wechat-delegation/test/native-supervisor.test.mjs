import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { NativeSupervisor, nativeAsset, loadBundled } from '../src/native-supervisor.mjs';
import { NativeStdioTransport } from '../src/native-stdio.mjs';

// Executable synthetic peer. This never opens a Keychain or contacts WeChat.
const source = Buffer.from(`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const dir=process.argv[process.argv.indexOf('--data-dir')+1];
fs.writeFileSync(path.join(dir,'started.json'),JSON.stringify({args:process.argv.slice(2),environment:Object.keys(process.env)}),{mode:0o600});
if(process.argv.includes('--initialize')) for(const name of ['vault.id','state.vault'])fs.writeFileSync(path.join(dir,name),'synthetic',{mode:0o600});
const caps=['stdio-v1','text-protocol-subset','account-login-v1','durable-text-send-v1','durable-text-sync-v1','current-directory-v1','explicit-session-resume-v1','canonical-message-lookup-v1','stable-text-stream-v1'];
readline.createInterface({input:process.stdin}).on('line',line=>{
const {id,method}=JSON.parse(line);
const result=method==='hello'?{product:'clowder-wechat-link',version:'test',pid:process.pid,protocolVersion:1,upstreamCommit:'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e',capabilities:caps,nativeApiAvailable:true,accountServiceReady:false}:{serverId:'synthetic-store',accountGeneration:0,accountIdentity:null,credentialsAvailable:false,authenticated:false,connection:'offline',stream:null,egress:[]};
process.stdout.write(JSON.stringify({id,result})+'\\n');
});
`);
const actor=()=>({signal:new AbortController().signal,assertCurrent:async()=>{}});
const asset=()=>({fileName:'clowder-link-test',version:'test',size:source.length,sha256:createHash('sha256').update(source).digest('hex')});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'wechat-owned-link-'));
  const supervisor=new NativeSupervisor({dataPath:root,asset:asset(),download:async()=>source});
  t.after(async()=>{await supervisor.stop();await rm(root,{recursive:true,force:true});});
  return {root,supervisor};
}
test('preparation verifies owned bytes and uses only private pipes, an empty environment and the new vault',async t=>{
  const {root,supervisor}=await fixture(t);const client=await supervisor.prepare(actor());
  assert.equal((await client.status()).connection,'offline');assert.equal(supervisor.child.pid,client.pid);
  assert.equal(await supervisor.prepare(actor()),client);
  const vault=join(await realpath(root),'link-vault');const started=JSON.parse(await readFile(join(vault,'started.json'),'utf8'));
  // macOS/Node may add this encoding variable after spawn; no owner env is passed.
  assert.equal(started.environment.every(key=>key==='__CF_USER_TEXT_ENCODING'),true);assert.deepEqual(started.args,['--data-dir',vault,'--initialize']);
  assert.equal((await stat(vault)).mode&0o777,0o700);
  await supervisor.stop();await assert.rejects(client.status());
});
test('binary cache repair preserves legacy profile data without opening it',async t=>{
  const {root,supervisor}=await fixture(t);await writeFile(join(root,asset().fileName),'partial binary');
  await mkdir(join(root,'native-profile'));await writeFile(join(root,'native-profile','history'),'preserve');
  await supervisor.prepare(actor());assert.equal(await readFile(join(root,'native-profile','history'),'utf8'),'preserve');
  await assert.rejects(stat(join(root,'native-config')),{code:'ENOENT'});
});
test('integrity, untrusted asset paths and an expired owner cannot start a process',async t=>{
  const {supervisor}=await fixture(t);supervisor.asset={...asset(),sha256:'0'.repeat(64)};
  await assert.rejects(supervisor.prepare(actor()),/integrity/);assert.equal(supervisor.child,undefined);
  supervisor.asset={...asset(),fileName:'../outside'};await assert.rejects(supervisor.prepare(actor()));assert.equal(supervisor.child,undefined);
  const control=new AbortController();control.abort();await assert.rejects(supervisor.prepare({signal:control.signal,assertCurrent:async()=>{}}));
});
test('state paths cannot follow symlinks; incomplete initialization is retained and never reinitialized',async t=>{
  for(const target of ['instance','link-vault'])await t.test(target,async t=>{
    const root=await mkdtemp(join(tmpdir(),'wechat-vault-path-'));const outside=join(root,'outside');await mkdir(outside,{mode:0o700});
    const instance=join(root,'instance');if(target==='instance')await symlink(outside,instance);else{await mkdir(instance,{mode:0o700});await symlink(outside,join(instance,target));}
    const supervisor=new NativeSupervisor({dataPath:instance,asset:asset(),download:async()=>source});
    t.after(async()=>{await supervisor.stop();await rm(root,{recursive:true,force:true});});
    await assert.rejects(supervisor.prepare(actor()),/private directory/);assert.equal(supervisor.child,undefined);
  });
  const {root,supervisor}=await fixture(t);await mkdir(join(root,'link-vault'),{mode:0o700});
  await writeFile(join(root,'link-vault','vault.id'),'original marker',{mode:0o600});
  await assert.rejects(supervisor.prepare(actor()),error=>error.code==='vault_repair_required');assert.equal(supervisor.child,undefined);
  assert.equal(await readFile(join(root,'link-vault','vault.id'),'utf8'),'original marker');
});
test('reopening uses the same vault but a new process identity; an old stop cannot kill the new child',async t=>{
  const {root,supervisor}=await fixture(t);const first=await supervisor.prepare(actor());
  const firstIdentity=await first.identity('clowder');await supervisor.stop();const second=await supervisor.prepare(actor());
  assert.notEqual((await second.identity('clowder')).serverId,firstIdentity.serverId);
  const started=JSON.parse(await readFile(join(root,'link-vault','started.json'),'utf8'));assert.deepEqual(started.args,['--data-dir',join(await realpath(root),'link-vault')]);
  await supervisor.stopOwned(first);assert.equal((await second.status()).serverId,'synthetic-store');
});
test('bundled rewritten component has exact source-pinned bytes; offline physical probe touches no Keychain', {skip:process.platform!=='darwin'||process.arch!=='arm64'},async t=>{
  const descriptor=nativeAsset('darwin','arm64');assert.equal(descriptor.product,'clowder-wechat-link');
  const bytes=await loadBundled(descriptor,new AbortController().signal);assert.equal(bytes.length,descriptor.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),descriptor.sha256);
  const root=await mkdtemp(join(tmpdir(),'wechat-link-offline-'));const binary=join(root,descriptor.fileName);await writeFile(binary,bytes,{mode:0o700});
  const child=spawn(binary,[],{env:{},stdio:['pipe','pipe','pipe'],shell:false});const transport=new NativeStdioTransport(child);
  t.after(async()=>{transport.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');await rm(root,{recursive:true,force:true});});
  const hello=await transport.request('hello');assert.equal(hello.pid,child.pid);assert.equal(hello.version,descriptor.version);assert.equal(hello.nativeApiAvailable,false);assert.equal(hello.accountServiceReady,false);
  await assert.rejects(transport.request('login.start',{operationId:'offline-only'}),error=>error.code==='not_ready'&&!error.mayHaveCommitted);
  assert.deepEqual((await transport.request('status')).egress,[]);
});
