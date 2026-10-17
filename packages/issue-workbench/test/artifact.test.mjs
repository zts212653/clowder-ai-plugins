import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../../../', import.meta.url));
function run(cmd,args,cwd) { return execFileSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024}); }
test('exact tgz installs outside the monorepo and persists source without runtime dependencies', t => {
  const dir = mkdtempSync(join(tmpdir(),'issue-packed-consumer-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const [pack] = JSON.parse(run(process.execPath,['scripts/pack-publish-artifact.mjs','packages/issue-workbench',dir],root));
  const tar = join(dir,pack.filename); const entries = run('tar',['-tzf',tar],dir);
  for (const path of ['data/initial-classification.v0.json','dist/index.js','dist/browser.js','dist/browser.css','dist/demo.js','dist/index.html','plugin.candidate.yaml','integration.json','LICENSE','sync-state.json','THIRD_PARTY_NOTICES.md','dist/licenses/react/LICENSE','dist/licenses/react-dom/LICENSE','dist/licenses/scheduler/LICENSE','dist/licenses/marked/LICENSE.md','dist/licenses/dompurify/LICENSE']) assert.ok(entries.includes('package/'+path));
  assert.doesNotMatch(entries,/node_modules|\.env|issue-snapshot|\/src\/|\/test\//);
  const consumer = join(dir,'consumer'); mkdirSync(consumer); writeFileSync(join(consumer,'package.json'),'{"type":"module"}');
  const npm = process.env.CLOWDER_ARTIFACT_NPM_CLI;
  run(npm ? process.execPath : 'npm', [...(npm ? [npm] : []),'install','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--package-lock=false',tar],consumer);
  const seed = JSON.parse(readFileSync(join(consumer, 'node_modules/@clowder-ai/issue-workbench/data/initial-classification.v0.json'), 'utf8'));
  assert.equal(seed.suggestions.length, 12);
  assert.ok(seed.suggestions.every(item => item.status === 'proposed' && item.humanAcceptance === null));
  run(process.execPath,['--input-type=module','--eval',`
    import assert from 'node:assert/strict';
    import { FileIssueSourceStore, IssueSourceService, createGhIssueSourceReader, emptyWork, acceptWork } from '@clowder-ai/issue-workbench';
    const repo='fixture/repo'; const directory='./isolated-source';
    const item={number:1,title:'Packed source',state:'OPEN',url:'https://example.test',labels:[],body:'preserved',updatedAt:'2026-10-14T00:00:00Z',comments:[],commentCount:0};
    const store=new FileIssueSourceStore(directory);
    const service=new IssueSourceService(store,async()=>({issues:[item],failures:[],complete:true}));
    await service.refresh(repo);
    const restored=await new FileIssueSourceStore(directory).readDetail(repo,1);
    assert.equal(restored.body,'preserved');
    assert.equal((await store.read(repo)).issues[0].body,undefined);
    assert.equal(typeof createGhIssueSourceReader,'function');
    assert.equal(acceptWork({...emptyWork(),solution:'answer',evidence:'test'}).stage,'resolved');
  `],consumer);
  console.log('Packed artifact:',JSON.stringify({filename:pack.filename,size:pack.size,integrity:pack.integrity}));
});
