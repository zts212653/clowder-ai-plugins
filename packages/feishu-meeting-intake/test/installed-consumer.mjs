import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import module from '@clowder-ai/feishu-meeting-intake';
import { validateManifest } from '@clowder-ai/plugin-contract';
const packageRoot=dirname(dirname(fileURLToPath(import.meta.resolve('@clowder-ai/feishu-meeting-intake'))));
const consumer=process.cwd();
assert.ok(!relative(consumer,packageRoot).startsWith('..'),'meeting module must be installed in this consumer');
const metadata=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
for(const [name,entry]of [['@clowder-ai/plugin-sdk','@clowder-ai/plugin-sdk'],['@clowder-ai/plugin-contract','@clowder-ai/plugin-contract'],['@modelcontextprotocol/sdk','@modelcontextprotocol/sdk/client/index.js']]){
 const bundledRoot=join(packageRoot,'node_modules',name),resolved=fileURLToPath(import.meta.resolve(entry));
 const local=relative(bundledRoot,resolved);
 assert.ok(local!== '..'&&!local.startsWith('..'+sep)&&!isAbsolute(local),name+' must resolve from the meeting bundle');
 assert.equal(JSON.parse(await readFile(join(bundledRoot,'package.json'),'utf8')).version,metadata.dependencies[name],name+' must retain its exact declared identity');
}
const manifest=JSON.parse(await readFile(join(packageRoot,'manifest.json'),'utf8'));
assert.equal(validateManifest(manifest).valid,true);
assert.deepEqual(manifest.icon,{type:'png',src:'assets/icon.png'});
const icon=await readFile(join(packageRoot,manifest.icon.src));
assert.equal(icon.subarray(0,8).toString('hex'),'89504e470d0a1a0a','installed icon must be a packaged PNG');
assert.ok(icon.byteLength>0&&icon.byteLength<=64*1024,'installed icon must stay bounded');
assert.equal(manifest.runtime.transport,'builtin');
assert.equal(manifest.signals,undefined);
assert.equal(typeof module.create,'function');
const data=await mkdtemp(join(tmpdir(),'meeting-installed-control-'));
try {
 const runnerManifest=JSON.parse(await readFile(join(packageRoot,'dist/lark-cli-runners.json'),'utf8'));
 assert.equal(runnerManifest.version,'1.0.85');
 assert.deepEqual(Object.keys(runnerManifest.runners),['darwin-arm64','linux-x64']);
 for(const runner of Object.values(runnerManifest.runners)){
  const archive=await readFile(join(packageRoot,'dist/lark-cli-runners',runner.asset));
  assert.equal(createHash('sha256').update(archive).digest('hex'),runner.archiveSha256);
 }
 const {materializeOwnedLarkRunner}=await import(pathToFileURL(join(packageRoot,'dist/owned-lark-command.js')).href);
 const selected=await materializeOwnedLarkRunner(data,async()=>{});
 assert.equal(selected.platform,process.platform);assert.equal(selected.arch,process.arch);
 assert.equal((await stat(selected.executable)).mode & 0o777,0o700,'selected runner must be private and executable');
 assert.equal(createHash('sha256').update(await readFile(selected.executable)).digest('hex'),selected.binarySha256);
 assert.match(execFileSync(selected.executable,['--version'],{env:{HOME:data},encoding:'utf8',timeout:10_000}),/1\.0\.85/);
 const active=await module.create(manifest).start({pluginInstanceId:'installed',dataPath:data,config:{async get(){throw new Error('First start must not read provider settings');}},secrets:{async get(){throw new Error('First start must not read credentials');}},storage:{},tasks:{},threads:{},media:{},messaging:{},log(){}});
 const owner={kind:'owner-operation',userId:'owner',pluginInstanceId:'installed',operationKey:'account',actionId:'status',requestId:'status',signal:new AbortController().signal,async assertCurrent(){}};
 const status=await active.actions['meeting.status']({input:{}},undefined,owner);
 assert.deepEqual(status.data,{auth:'not_configured',collectionIntent:'disabled',live:'stopped'});
 const sourceOwner={...owner,operationKey:'sourceMaterial',actionId:'invoke',requestId:'source-material'};
 const sourceMaterial=await active.actions['meeting.sourceMaterial']({input:{},operationState:{currentAction:'invoke',updatedAt:1}},undefined,sourceOwner);
 assert.deepEqual(sourceMaterial.data,{kind:'project_source_sharing'},'installed Host must reach the generic source-material operation');
 await active.stop();
 await assert.rejects(()=>active.actions['meeting.status']({input:{}},undefined,owner),/stopped|revoked/);
 const require=createRequire(join(packageRoot,'package.json'));
 const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
 const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const client=new Client({name:'meeting-installed-test',version:'1.0.0'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageRoot,'dist/mcp-entrypoint.js')],env:{HOME:data,PATH:process.env.PATH??''},stderr:'pipe'}));
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(t=>t.name).sort(),['cat_cafe_meeting_records_list','cat_cafe_meeting_records_read'].sort());
  for(const tool of tools){assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(Object.hasOwn(tool.inputSchema.properties??{},'userId'),false);assert.equal(Object.hasOwn(tool.inputSchema.properties??{},'threadId'),false);}
  const denied=await client.callTool({name:'cat_cafe_meeting_records_list',arguments:{}});
  assert.equal(denied.isError,true,'missing authenticated native credentials must fail closed');
 } finally {await client.close();}
 console.log(JSON.stringify({journey:'installed meeting module + runner + source operation + strict MCP',status:'PASS',platform:selected.platform,arch:selected.arch,binarySha256:selected.binarySha256}));
} finally {await rm(data,{recursive:true,force:true});}
