import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceDigest, type MigrationSource } from './migration-source.js';

const execute = promisify(execFile);
test('real file producer freezes only bounded GitHub input, keeps source bytes and writes private non-overwriting output',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'clowder-github-source-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'source.json'),output=join(dir,'frozen.json');
  const source:MigrationSource={v:1,id:'fixture',userId:'owner',sourceRef:'isolated:owner-approved-source',capturedAt:1,oldWriter:'absent',
    coverage:{tracking:'complete',repositories:'complete',progress:'complete','pending-receipts':'complete','authority-retention':'complete'},
    tasks:[],repositories:[],receipts:[],retainedAuthorityRefs:['isolated:old-authority-remains-at-source'],unresolvedRepositoryDeliveries:0};
  const raw=JSON.stringify(source);await writeFile(input,raw);
  const run=(path:string,target:string)=>execute(process.execPath,['--import','tsx',new URL('./migration-source-cli.ts',import.meta.url).pathname,'--input',path,'--output',target]);
  const result=await run(input,output),summary=JSON.parse(result.stdout);
  assert.equal(summary.digest,sourceDigest(source));assert.equal(summary.rawContentPrinted,false);
  assert.equal((await stat(output)).mode&0o777,0o600);assert.equal(await readFile(input,'utf8'),raw);
  const cliAlias=join(dir,'source-cli-alias.ts');await symlink(new URL('./migration-source-cli.ts',import.meta.url).pathname,cliAlias);
  const aliased=await execute(process.execPath,['--import','tsx',cliAlias,'--input',input,'--output',join(dir,'aliased.json')]);
  assert.equal(JSON.parse(aliased.stdout).digest,summary.digest,'an alias path executes the same physical CLI');
  await assert.rejects(run(input,output),/EEXIST/);
  const link=join(dir,'link.json');await symlink(input,link);await assert.rejects(run(link,join(dir,'linked-output.json')),/ELOOP/);
  await writeFile(input,JSON.stringify({...source,messages:[{body:'Unrelated chat must not enter this producer'}]}));
  await assert.rejects(run(input,join(dir,'bad.json')),/Only bounded GitHub/);
  await writeFile(input,JSON.stringify({...source,tasks:[{id:'unrelated-work',kind:'work',messages:[{body:'not tracking metadata'}]}]}));
  await assert.rejects(run(input,join(dir,'wrong-family.json')),/GitHub tracking source/);
});
