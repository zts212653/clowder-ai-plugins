import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from './feature-context.js';
import { threadMappings } from './thread-mappings.js';
test('conversation mapping survives a plugin restart and concurrent ingress creates one ordinary thread', async () => {
  let revision = 0; let value: unknown; let creates = 0;
  const rows = new Map();
  const storage = { async get() { return revision ? { revision, value } : undefined; },
    async compareAndSet(_key: string, expected: number | null, next: unknown) {
      assert.equal(expected, revision || null); value = structuredClone(next); return { applied: true, revision: ++revision };
    } };
  const threads = { async get(id: string) { return rows.get(id) ?? null; }, async create(input: unknown) {
    const row = { id: `thread-${++creates}`, input }; rows.set(row.id, row); return row;
  } };
  const context = { threads, storage } as unknown as FeatureContext;
  const mappings = threadMappings(context);
  const [first, concurrent] = await Promise.all([mappings.ensureByKey('chat', { title: 'Chat' }), mappings.ensureByKey('chat', { title: 'Chat' })]);
  assert.equal(first.id, concurrent.id); assert.equal(creates, 1);
  assert.equal((await threadMappings({ threads, storage } as unknown as FeatureContext).findByKey('chat'))?.id, first.id);
  assert.deepEqual(await mappings.listBindings(), [{ key: 'chat', threadId: first.id, createdAt: (value as {createdAt:number}[])[0]!.createdAt }]);
});


for (const directory of ['plugin-sdk','connector-dingtalk','connector-feishu','connector-telegram','connector-wecom-agent','connector-wecom-bot','connector-weixin','connector-xiaoyi','collective-connector','github-operations']) {
  test(`${directory}: lost ordinary create response allows recreation and saves the successful mapping`, async () => {
    const { threadMappings: mappingsFor } = await import(new URL(`../../${directory}/src/thread-mappings.ts`, import.meta.url).href);
    let revision=0, creates=0; let value:unknown;
    const rows=new Map();
    const context={
      storage:{async get(){return revision?{revision,value}:undefined;},async compareAndSet(_key:string,expected:number|null,next:unknown){assert.equal(expected,revision||null);value=structuredClone(next);return {applied:true,revision:++revision};}},
      threads:{async get(id:string){return rows.get(id)??null;},async create(input:Record<string,unknown>){
        assert.deepEqual(Object.keys(input).sort(),['parentThreadId','participants','title']);
        const row={id:`thread-${++creates}`,title:input.title};rows.set(row.id,row);
        if(creates===1)throw new Error('response lost after Host create');return row;
      }},
    } as unknown as FeatureContext;
    const mappings=mappingsFor(context);const input={title:'Conversation',parentThreadId:'parent',participants:['cat-1']};
    await assert.rejects(mappings.ensureByKey('provider-chat',input),/response lost/);
    assert.equal(revision,0);
    const created=await mappings.ensureByKey('provider-chat',input);
    assert.equal(created.id,'thread-2');assert.equal(creates,2);
    assert.equal((await mappings.findByKey('provider-chat'))?.id,'thread-2');
    assert.equal((await mappings.ensureByKey('provider-chat',input)).id,'thread-2');assert.equal(creates,2);
  });
}
