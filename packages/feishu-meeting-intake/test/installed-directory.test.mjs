import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../../../',import.meta.url));
function run(command,args,cwd,envOverrides={}){const env={...process.env,...envOverrides};delete env.NODE_PATH;delete env.NODE_OPTIONS;const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024});assert.equal(result.status,0,[command,...args,result.stdout,result.stderr].join('\n'));return result.stdout;}
async function fileBytes(directory){let bytes=0;for(const name of await readdir(directory)){const path=join(directory,name),stat=await lstat(path);if(stat.isDirectory())bytes+=await fileBytes(path);else{assert.ok(stat.isFile(),'archive has a non-regular member');bytes+=stat.size;}}return bytes;}
test('one meeting archive installs offline with an empty npm cache and runs its bundled module, runner and MCP',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'meeting-empty-consumer-')),packs=join(temp,'packs'),consumer=join(temp,'consumer');
 try {
  await mkdir(packs);await mkdir(consumer);const artifacts=[];
  for(const name of ['plugin-contract','plugin-sdk','feishu-meeting-intake']){
   run('pnpm',['--filter','@clowder-ai/'+name,'build'],root);
   if(name!=='feishu-meeting-intake')continue;
   // A frozen installation must pack offline even with a completely empty
   // registry metadata cache (the real pnpm 9 hoisted-deploy CI failure).
   const [pack]=JSON.parse(run(process.execPath,['scripts/pack-publish-artifact.mjs','packages/'+name,packs],root,
    {XDG_CACHE_HOME:join(temp,'cache'),npm_config_cache_dir:join(temp,'metadata'),npm_config_offline:'true'}));
   if(name==='feishu-meeting-intake'){
    assert.equal(pack.files.some(file=>file.path==='node_modules/@larksuite/cli/bin/lark-cli'),false,
     'postinstall-generated vendor runner must not duplicate the fixed runner archives');
    assert.equal(pack.files.some(file=>file.path==='dist/lark-cli'),false,
     'a build-host binary must never define the public archive identity');
    assert.deepEqual(pack.files.filter(file=>file.path.startsWith('dist/lark-cli-runners/')).map(file=>file.path),[
     'dist/lark-cli-runners/lark-cli-1.0.85-darwin-arm64.tar.gz',
     'dist/lark-cli-runners/lark-cli-1.0.85-linux-amd64.tar.gz',
    ]);
    const budget=join(temp,'budget');await mkdir(budget);run('tar',['-xzf',join(packs,pack.filename),'-C',budget],temp);
    assert.ok(await fileBytes(budget)<=64*1024*1024,'meeting archive exceeds Host uncompressed budget');
   }
   artifacts.push(join(packs,pack.filename));console.log(JSON.stringify({name,sha1:pack.shasum,integrity:pack.integrity,members:pack.files.length}));
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  assert.equal(artifacts.length,1,'only the self-contained meeting archive is an install input');
  const cache=join(temp,'empty-npm-cache');
  await assert.rejects(lstat(cache),{code:'ENOENT'});
  run('npm',['install','--offline','--cache',cache,'--ignore-scripts','--no-audit','--no-fund','--package-lock=false',...artifacts],consumer,
   {XDG_CACHE_HOME:join(temp,'install-cache'),npm_config_offline:'true'});
  for(const name of ['plugin-sdk','plugin-contract'])
   await assert.rejects(lstat(join(consumer,'node_modules/@clowder-ai',name)),{code:'ENOENT'},'no separate root dependency may supply the meeting bundle');
  const installed=join(consumer,'node_modules/@clowder-ai/feishu-meeting-intake');
  const journey=join(installed,'installed-journey.mjs');
  await cp(new URL('./installed-consumer.mjs',import.meta.url),journey);
  console.log(run(process.execPath,[journey],consumer,{npm_config_offline:'true'}));
  if(process.env.F202_MEETING_ARTIFACT_DIR){await mkdir(process.env.F202_MEETING_ARTIFACT_DIR,{recursive:true});for(const artifact of artifacts)await cp(artifact,join(process.env.F202_MEETING_ARTIFACT_DIR,artifact.split('/').at(-1)));}
 } finally {await rm(temp,{recursive:true,force:true});}
});
