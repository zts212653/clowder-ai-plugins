import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse as parseYaml} from 'yaml';
import {assertPackageArchiveLayout} from '../../../scripts/verify-self-contained-artifact.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
function run(command,args,cwd,env=process.env) {
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:16*1024*1024});
 assert.equal(result.status,0,[result.stdout,result.stderr].join('\n'));return result.stdout;
}

test('canonical bundled archive installs offline in an empty consumer and runs setup/enable/stop/restart',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'dot-packed-consumer-')),packs=join(temporary,'packs'),consumer=join(temporary,'consumer');
 await mkdir(packs);await mkdir(consumer);
 try {
  run('pnpm',['--filter','@clowder-ai/chatgpt-dot','build'],root);
  const [packed]=JSON.parse(run(process.execPath,['scripts/pack-publish-artifact.mjs','packages/chatgpt-dot',packs],root));
  const archive=join(packs,packed.filename);assertPackageArchiveLayout(archive);
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  run('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund','--package-lock=false','--cache',join(temporary,'empty-cache'),archive],consumer,
    {...process.env,NODE_PATH:'',NODE_ENV:'development'});
  const installed=join(consumer,'node_modules/@clowder-ai/chatgpt-dot');
  for(const file of ['README.md','README.en.md','plugin.yaml'])assert.deepEqual(await readFile(join(installed,file)),await readFile(join(root,'packages/chatgpt-dot',file)));
  const actualManifest=parseYaml(await readFile(join(installed,'plugin.yaml'),'utf8'));
  const output=run(process.execPath,['--input-type=module','--eval',`
   import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
   import{createRequire}from'node:module';import{join,dirname}from'node:path';import{pathToFileURL,fileURLToPath}from'node:url';
   const entry=import.meta.resolve('@clowder-ai/chatgpt-dot'),pkgRoot=dirname(dirname(fileURLToPath(entry)));
   const manifest=JSON.parse(process.argv[1]);
   const module=(await import(entry)).default.create(manifest),records=new Map();let revision=0;
   const host={pluginInstanceId:'fresh-instance',dataPath:join(process.cwd(),'private-data'),config:{get:async()=>undefined},secrets:{get:async()=>undefined},log(){},
    storage:{get:async key=>records.get(key),list:async()=>Object.fromEntries(records),compareAndSet:async(key,expected,value)=>{if((records.get(key)?.revision??null)!==expected)return{applied:false};records.set(key,{revision:++revision,value});return{applied:true,revision};}},
    messaging:{subscribe:async()=>assert.fail('unexpected global subscription')}};
   const owner={kind:'owner-operation',pluginInstanceId:host.pluginInstanceId,userId:'owner',operationKey:'connection',actionId:'begin',requestId:'request',signal:new AbortController().signal,assertCurrent:async()=>{}};
   const settings=await module.settings(host),first=(await settings.actions['dot.begin']({},undefined,owner)).data;
   await settings.dispose();const active=await module.start(host);assert.equal(typeof active.actions.deliverMessage,'function');
   assert.equal((await active.actions['dot.test']({},undefined,owner)).ok,false);await active.stop({reason:'disabled'});
   const secondSettings=await module.settings(host),second=(await secondSettings.actions['dot.begin']({},undefined,owner)).data;
   assert.equal(first.attemptId,second.attemptId);assert.equal(first.credentialSecret,second.credentialSecret);
   await secondSettings.dispose();const restarted=await module.start(host);await restarted.stop({reason:'uninstall'});await module.uninstall(host);
   console.log(JSON.stringify({offlineInstall:true,setup:true,enableStopRestart:true,retained:true}));
  `,JSON.stringify(actualManifest)],consumer,{...process.env,NODE_PATH:''});
  assert.match(output,/"retained":true/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
