import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { PluginStorageHost, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { PrProviderIndex, type PrIndexProvider } from './pr-provider-index.js';

function fixture() {
  const rows = new Map<string, PluginStorageEntry>(); let revision = 0;
  const storage: PluginStorageHost = {
    get: async key => structuredClone(rows.get(key)),
    list: async () => structuredClone(Object.fromEntries(rows)),
    set: async (key, value) => { rows.set(key, { value: structuredClone(value), revision: ++revision }); return { revision }; },
    compareAndSet: async (key, expected, value) => {
      if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
      rows.set(key, { value: structuredClone(value), revision: ++revision }); return { applied: true, revision };
    },
    delete: async (key, expected) => ({ deleted: (expected === undefined || rows.get(key)?.revision === expected) && rows.delete(key) }),
  };
  return { storage, rows, root: () => [...rows].find(([key]) => key.endsWith('.root'))! };
}
const repo = 'owner/repo';
const pr = (number = 1, overrides = {}) => ({ updated_at: '2026-10-08T00:00:00Z', number, title: `PR ${number}`, user: 'author', state: 'open', merged_at: null, head_sha: 'a'.repeat(40), draft: true, ...overrides });
const review = (commit = 'a') => ({ user: 'reviewer', state: 'COMMENTED', commit_id: commit.repeat(40) });

test('frozen alpha12 draft and alpha13-touched legacy draft restart without publishing old chunks', async () => {
  const frozen=JSON.parse(await readFile(new URL('../test/fixtures/pr-index-alpha12-page.json',import.meta.url),'utf8'));
  assert.equal(frozen.sourceHead,'30ec27976b674a7c566fe7da2fc533960d95215b');
  for (const touched of [false,true]) {
    const f=fixture(); const entries=structuredClone(frozen.entries) as Record<string,PluginStorageEntry>;
    for(const [key,entry] of Object.entries(entries)) {
      if(touched && key.endsWith('.root')) (entry.value as any).draft.pending=null;
      await f.storage.set(key,entry.value);
    }
    const oldChunks=structuredClone([...f.rows].filter(([key])=>!key.endsWith('.root')));
    const pages:number[]=[]; let fail=true;
    const index=new PrProviderIndex(f.storage,{page:async(_repo,page)=>{
      pages.push(page);if(fail)throw Error('unavailable');
      return page===1?Array.from({length:25},(_,i)=>pr(i+1)):[pr(26)];
    },reviewPage:async()=>[]});
    const originalRoot=structuredClone(f.root());
    assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),originalRoot);
    fail=false; assert.equal((await index.refresh({repo})).status,'incomplete');
    assert.equal((await index.read(repo)).publishedGeneration,null);
    assert.equal((await index.refresh({repo})).status,'complete');
    const result=await index.read(repo); assert.equal(result.items.length,26);
    assert.deepEqual(pages,[1,1,2]);
    assert.ok(result.items.every(row=>row.subjectKey===`pr:${repo}#${row.number}` && row.updatedAt===Date.parse('2026-10-08T00:00:00Z')));
    for(const [key,entry] of oldChunks) assert.deepEqual(f.rows.get(key),entry);
    const published=(f.root()[1].value as any).published;
    assert.ok(published.parts.every((key:string)=>!oldChunks.some(([old])=>old===key)));
    await index.stop();
  }
});

test('review deadline resumes at unfinished subject and review page across restart', async () => {
  const f = fixture(); const calls: string[] = []; let slow = true;
  const fetchReview = async (_repo: string, number: number, page: number) => {
    calls.push(`${number}:${page}`);
    if (number === 3 && page === 2 && slow) await new Promise(r => setTimeout(r, 45));
    return number === 3 && page === 1 ? Array.from({length:100}, () => review()) : [review()];
  };
  const provider = { page: async () => [pr(1), pr(2), pr(3)],
    reviewPage: fetchReview,
  };
  let index = new PrProviderIndex(f.storage, provider, 30);
  assert.equal((await index.refresh({repo})).status, 'failed');
  assert.equal((await index.read(repo)).publishedGeneration, null);
  assert.deepEqual(calls,['1:1','2:1','3:1','3:2']);
  await index.stop(); slow = false; index = new PrProviderIndex(f.storage,provider,30);
  assert.equal((await index.refresh({repo})).status,'complete');
  assert.deepEqual(calls,['1:1','2:1','3:1','3:2','3:2']);
  assert.equal((await index.read(repo)).items.length,3); await index.stop();
});

test('published rows have stable subject identity and provider activity independent from sweep time', async () => {
  const f = fixture();
  const index = new PrProviderIndex(f.storage,{page:async()=>[pr(1,{updated_at:'2026-10-08T00:00:00Z'})],reviewPage:async()=>[]});
  await index.refresh({repo:'Owner/Repo'}); const first = (await index.read(repo)).items[0] as unknown as Record<string, unknown>;
  assert.equal(first.subjectKey,'pr:owner/repo#1'); assert.equal(first.updatedAt,Date.parse('2026-10-08T00:00:00Z'));
  await index.refresh({repo}); const second = (await index.read(repo)).items[0] as unknown as Record<string, unknown>;
  assert.equal(second.subjectKey,first.subjectKey); assert.equal(second.updatedAt,first.updatedAt); await index.stop();
});

test('late page failure keeps published bytes/revisions; restart resumes staging and publishes atomically', async () => {
  const f = fixture(); let batch = 0, fail = true; const pages: number[] = [];
  const provider: PrIndexProvider = {
    page: async (_repo, page) => { pages.push(page); if (!batch) return [pr(100)]; if (page === 1) return Array.from({length:25}, (_, i) => pr(i+1)); if (fail) throw Error('last page'); return [pr(26)]; },
    reviewPage: async () => [review()],
  };
  let index = new PrProviderIndex(f.storage, provider);
  await index.refresh({ repo }); const old = await index.read(repo); const oldParts = structuredClone([...f.rows].filter(([key]) => key.includes(old.publishedGeneration!)));
  batch = 1; assert.equal((await index.refresh({ repo })).status, 'incomplete');
  assert.deepEqual((await index.read(repo)).items, old.items);
  const beforeFailure = structuredClone(f.root());
  assert.equal((await index.refresh({ repo })).status, 'failed');
  assert.deepEqual(f.root(), beforeFailure); assert.equal((await index.read(repo)).refreshStatus, 'failed');
  assert.deepEqual([...f.rows].filter(([key]) => key.includes(old.publishedGeneration!)), oldParts);
  await index.stop(); index = new PrProviderIndex(f.storage, provider); fail = false;
  assert.equal((await index.refresh({ repo })).status, 'complete');
  const page = await index.read(repo, undefined, 20);
  assert.equal(page.items.length, 20); assert.notEqual(page.publishedGeneration, old.publishedGeneration);
  assert.equal((await index.read(repo, page.nextAfter, 20)).items.length, 6);
  assert.deepEqual(pages, [1,1,2,2]); assert.equal((await index.repositories())[0]!.count, 26);
  await index.refresh({ repo, restart: true });
  assert.equal((await index.read(repo, page.nextAfter)).items.length, 6);
  await index.refresh({ repo });
  await assert.rejects(index.read(repo, page.nextAfter), /stale/);
  await index.stop();
});

test('same display state updates reviewed SHA and draft; terminal states clear reviewed SHA', async () => {
  const f = fixture(); let value = pr(), reviews = [review('b')];
  const index = new PrProviderIndex(f.storage, { page: async () => [value], reviewPage: async () => reviews });
  await index.refresh({repo}); assert.equal((await index.read(repo)).items[0]!.replyState, 'has-new-activity');
  value = pr(1, {draft:false}); reviews = [review('c')]; await index.refresh({repo});
  let row = (await index.read(repo)).items[0]!; assert.equal(row.replyState,'has-new-activity'); assert.equal(row.lastReviewedSha,'c'.repeat(40)); assert.equal(row.draft,false);
  value = pr(1, {state:'closed'}); await index.refresh({repo}); row = (await index.read(repo)).items[0]!;
  assert.equal(row.state,'closed'); assert.equal(row.lastReviewedSha,null); assert.equal(row.draft,true);
  value = pr(1, {state:'closed',merged_at:'2026-10-09T00:00:00Z'}); await index.refresh({repo});
  assert.equal((await index.read(repo)).items[0]!.state,'merged'); assert.equal((await index.read(repo)).items[0]!.lastReviewedSha,null);
  await index.stop();
});

test('failed review preserves published revision and reports its subject', async () => {
  const f=fixture(); let fail=false;
  const index=new PrProviderIndex(f.storage,{page:async()=>[pr()],reviewPage:async()=>{if(fail)throw Error('unavailable');return [review()];}});
  await index.refresh({repo}); const generation=(await index.read(repo)).publishedGeneration!;
  const before=structuredClone([...f.rows].filter(([key])=>key.includes(generation))); fail=true;
  const result=await index.refresh({repo}); assert.deepEqual(result.failedSubjects,[1]); assert.equal(result.status,'failed');
  assert.deepEqual([...f.rows].filter(([key])=>key.includes(generation)),before);
  assert.equal((await index.read(repo)).publishedGeneration,generation);
  assert.equal((await index.read(repo)).refreshStatus,'failed');
  assert.equal((await index.read(repo)).items[0]!.replyState,'replied'); await index.stop();
});

test('malformed, duplicate and authority-bearing inputs cannot publish', async () => {
  const f=fixture(); let calls=0, values: unknown[]=[pr()];
  const index=new PrProviderIndex(f.storage,{page:async()=>{calls++;return values;},reviewPage:async()=>[]});
  await assert.rejects(index.refresh({repo,verdict:'approved'})); assert.equal(calls,0);
  await index.refresh({repo}); const before=structuredClone(f.root());
  for(const bad of [[pr(1,{head_sha:'bad'})],[pr(),pr()],[pr(1,{draft:'yes'})]]){
    values=bad; assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),before);
  }
  values=Array.from({length:25},(_,i)=>pr(i+1)); await index.refresh({repo}); const staged=structuredClone(f.root());
  values=[pr(25)]; assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),staged); await index.stop();
});

test('two instances race publication: one complete generation wins', async () => {
  const f=fixture(); let release!:()=>void, entered!:()=>void; const ready=new Promise<void>(r=>entered=r), wait=new Promise<void>(r=>release=r);
  const a=new PrProviderIndex(f.storage,{page:async()=>{entered();await wait;return[pr(1)];},reviewPage:async()=>[]});
  const b=new PrProviderIndex(f.storage,{page:async()=>[pr(2)],reviewPage:async()=>[]});
  const first=a.refresh({repo}); await ready; assert.equal((await b.refresh({repo})).status,'complete'); release();
  assert.equal((await first).status,'failed'); assert.deepEqual((await b.read(repo)).items.map(x=>x.number),[2]);
  assert.equal((await b.read(repo)).refreshStatus,'complete'); await Promise.all([a.stop(),b.stop()]);
});

test('stop aborts provider and joins cleanup; late completion cannot publish', async () => {
  const f=fixture(); let release!:()=>void, entered!:()=>void, signal!:AbortSignal;
  const ready=new Promise<void>(r=>entered=r), wait=new Promise<void>(r=>release=r);
  const index=new PrProviderIndex(f.storage,{page:async(_r,_p,s)=>{signal=s;entered();await wait;return[pr()];},reviewPage:async()=>[]});
  const running=assert.rejects(index.refresh({repo})); await ready; let stopped=false; const stop=index.stop().then(()=>stopped=true);
  await new Promise(r=>setImmediate(r)); assert.equal(signal.aborted,true); assert.equal(stopped,false); release(); await Promise.all([running,stop]);
  assert.equal(f.rows.size,0); await assert.rejects(index.refresh({repo}),/stopped/);
});

test('deadline failure preserves the visible generation', async () => {
  const f=fixture(); let slow=false;
  const index=new PrProviderIndex(f.storage,{page:async()=>{if(slow)await new Promise(r=>setTimeout(r,25));return[pr()];},reviewPage:async()=>[]},10);
  await index.refresh({repo}); const before=structuredClone(f.root()); slow=true;
  assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),before); await index.stop();
});

test('subject cap remains incomplete until an explicit empty final page; overflow never publishes', async () => {
  const f = fixture(); let overflow = true;
  const index = new PrProviderIndex(f.storage, {
    page: async (_repo, page) => page <= 200 ? Array.from({length:25}, (_, i) => pr((page - 1) * 25 + i + 1, {state:'closed'})) : overflow ? [pr(5001)] : [],
    reviewPage: async () => { throw Error('terminal PR must not fetch reviews'); },
  });
  for (let page = 1; page <= 200; page++) assert.equal((await index.refresh({repo})).status,'incomplete');
  assert.equal((await index.read(repo)).publishedGeneration,null);
  const before = structuredClone(f.root());
  const result = await index.refresh({repo}); assert.equal(result.status,'limit_exceeded'); assert.equal(result.complete,false);
  assert.deepEqual(f.root(),before); assert.equal((await index.read(repo)).refreshStatus,'limit_exceeded');
  overflow=false; assert.equal((await index.refresh({repo})).status,'complete');
  assert.equal((await index.repositories())[0]!.count,5000); await index.stop();
});

test('review cap is explicit and cannot turn a partial fold into a published row', async () => {
  const f=fixture(); let calls=0;
  const index=new PrProviderIndex(f.storage,{page:async()=>[pr()],reviewPage:async()=>{calls++;return Array.from({length:100},()=>review());}});
  const result=await index.refresh({repo}); assert.equal(result.status,'limit_exceeded'); assert.equal(result.complete,false);
  assert.deepEqual(result.failedSubjects,[1]); assert.equal(calls,100); assert.equal((await index.read(repo)).publishedGeneration,null);
  await index.stop();
});

test('invalid provider times refuse publication; old rows without time require refresh instead of fabricated dates', async () => {
  const f=fixture(); let value=pr();
  const index=new PrProviderIndex(f.storage,{page:async()=>[value],reviewPage:async()=>[]});
  await index.refresh({repo}); const before=structuredClone(f.root());
  for (const updated_at of ['bad','2026-02-30T00:00:00Z',undefined]) {
    value=pr(1,{updated_at}); assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),before);
  }
  const part=[...f.rows].find(([key,entry])=>!key.endsWith('.root') && Array.isArray(entry.value) && entry.value[0]?.subjectKey)!;
  const legacy=structuredClone(part[1].value) as Record<string,unknown>[]; delete legacy[0]!.subjectKey; delete legacy[0]!.updatedAt;
  await f.storage.set(part[0],legacy); await assert.rejects(index.read(repo),/refresh required/); await index.stop();
});
