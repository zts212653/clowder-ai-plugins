import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
const root = fileURLToPath(new URL('../../../', import.meta.url));
function run(cmd,args,cwd) { return execFileSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024}); }
test('exact tgz installs outside the monorepo and persists source without runtime dependencies', t => {
  const dir = mkdtempSync(join(tmpdir(),'issue-packed-consumer-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const [pack] = JSON.parse(run(process.execPath,['scripts/pack-publish-artifact.mjs','packages/issue-workbench',dir],root));
  const tar = join(dir,pack.filename); const entries = run('tar',['-tzf',tar],dir);
  for (const path of ['data/initial-classification.v0.json','dist/index.js','dist/browser.js','dist/browser.css','dist/demo.js','dist/index.html','dist/team-plugin.js','plugin.yaml','integration.json','README.md','README.en.md','HOST-TESTING.md','LICENSE','sync-state.json','THIRD_PARTY_NOTICES.md','dist/licenses/react/LICENSE','dist/licenses/react-dom/LICENSE','dist/licenses/scheduler/LICENSE','dist/licenses/marked/LICENSE.md','dist/licenses/dompurify/LICENSE']) assert.ok(entries.includes('package/'+path));
  assert.doesNotMatch(entries,/node_modules|\.env|issue-snapshot|\/src\/|\/test\//);
  const consumer = join(dir,'consumer'); mkdirSync(consumer); writeFileSync(join(consumer,'package.json'),'{"type":"module"}');
  const npm = process.env.CLOWDER_ARTIFACT_NPM_CLI;
  run(npm ? process.execPath : 'npm', [...(npm ? [npm] : []),'install','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--package-lock=false',tar],consumer);
  assert.ok(entries.includes('package/dist/team-mcp.js'));
  const nativeEnvironment = { ...process.env,
    ISSUE_WORKBENCH_NATIVE_ENTRY: join(consumer, 'node_modules/@clowder-ai/issue-workbench/dist/team-mcp.js') };
  delete nativeEnvironment.NODE_TEST_CONTEXT;
  const nativeResult = execFileSync(process.execPath, ['--test', join(root, 'packages/issue-workbench/test/native-mcp.test.mjs')], {
    cwd: consumer, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: nativeEnvironment,
  });
  assert.match(nativeResult, /pass 2/);
  const seed = JSON.parse(readFileSync(join(consumer, 'node_modules/@clowder-ai/issue-workbench/data/initial-classification.v0.json'), 'utf8'));
  assert.equal(seed.suggestions.length, 12);
  assert.ok(seed.suggestions.every(item => item.status === 'proposed' && item.humanAcceptance === null));
  const batch = JSON.parse(readFileSync(join(consumer, 'node_modules/@clowder-ai/issue-workbench/data/first-classification.v1.json'), 'utf8'));
  assert.equal(batch.catalog.total, batch.suggestions.length + batch.catalog.featureBound);
  assert.equal(batch.suggestions.length, 708);
  writeFileSync(join(consumer, 'team-manifest.json'), JSON.stringify(parse(readFileSync(join(consumer, 'node_modules/@clowder-ai/issue-workbench/plugin.yaml'), 'utf8'))));
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
    const { default: team } = await import('./node_modules/@clowder-ai/issue-workbench/dist/team-plugin.js');
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync('./team-manifest.json','utf8'));
    const unexpected = async () => { throw new Error('Unconfigured plugin must not perform external work'); };
    const host = { pluginInstanceId: 'packed-isolated-host', dataPath: './isolated-team',
      config: { get: async () => undefined }, secrets: { get: unexpected },
      storage: { get: async () => undefined, list: async () => ({}), set: unexpected, compareAndSet: unexpected, delete: unexpected },
      tasks: {}, threads: {}, streams: {}, messaging: { get: unexpected, send: unexpected, subscribe: unexpected, unsubscribe: unexpected }, log() {} };
    const activation = await team.create(manifest).start(host);
    for (const method of ['inspect','analyze','submit','get','list','receive','report','feedback','statistics']) assert.equal(typeof activation.actions['issue.team.' + method], 'function');
    await assert.rejects(activation.actions['issue.team.analyze']({ repo: 'fixture/repo', number: 1, requestId: 'x' }), /Host caller/);
    const authority = { kind: 'owner-operation', pluginInstanceId: host.pluginInstanceId, userId: 'fixture',
      operationKey: 'teamStatus', actionId: 'status', requestId: 'request', signal: new AbortController().signal, assertCurrent: async () => {} };
    const status = await activation.actions['issue.team.health']({}, undefined, authority);
    assert.equal(status.data.configured, false);
    assert.equal(status.data.recovery.state, 'needs-setup');
    await activation.stop();
    await assert.rejects(activation.actions['issue.team.health']({}, undefined, authority), /stopped/);
  `],consumer);
  console.log('Packed artifact:',JSON.stringify({filename:pack.filename,size:pack.size,integrity:pack.integrity}));
});
