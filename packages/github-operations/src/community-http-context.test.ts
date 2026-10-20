import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import Fastify from 'fastify';
import { CommunityRequestContext } from './business/routes/community-request-context.js';
import { memoryStorage } from '../test/memory-storage.js';

test('request storage rejects writes after native invocation loss or module stop', async t => {
  const app = Fastify(); t.after(() => app.close());
  const context = new CommunityRequestContext(app);
  const backing = memoryStorage();
  const storage = context.mutationStorage(backing);
  let current = true;
  app.post('/write', async () => {
    await storage.get('record');
    current = false;
    await storage.compareAndSet('record', null, 'should not persist');
  });
  app.post('/stop', async () => {
    context.stop();
    await storage.set('late', 'should not persist');
  });
  const caller = { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => { if (!current) throw new Error('stale'); } };
  assert.equal((await context.injectNative(caller, { method: 'POST', url: '/write' })).statusCode, 500);
  assert.deepEqual(await backing.list(), {});
  await backing.set('kept', 'value');
  await assert.rejects(storage.delete('kept'), /Authenticated/);
  assert.equal((await context.injectOwner({ kind: 'owner', id: 'owner' }, { method: 'POST', url: '/stop' })).statusCode, 500);
  assert.equal(await backing.get('late'), undefined);
  await assert.rejects(async () => context.injectOwner({ kind: 'owner', id: 'owner' }, { method: 'POST', url: '/stop' }), /stopped/);
});

test('request identity comes from Host context, never copied headers or business fields', async () => {
  const app = Fastify(); const context = new CommunityRequestContext(app);
  app.get('/who', async request => ({ user: context.userId(request), cat: context.caller()?.catId ?? null }));
  const anonymous = await app.inject({ url: '/who', headers: { 'x-cat-cafe-user': 'forged', 'x-callback-token': 'fake' } });
  assert.deepEqual(anonymous.json(), { user: null, cat: null });
  const owner = await context.injectOwner({ kind: 'owner', id: 'real-owner' }, { url: '/who', headers: { 'X-Community-Local-Request': 'forged' } });
  assert.deepEqual(owner.json(), { user: 'real-owner', cat: null });
  await app.close();
});

test('concurrent native requests keep separate authenticated identities and recheck liveness', async () => {
  const app = Fastify(); const context = new CommunityRequestContext(app); let checks = 0;
  app.get('/who', async request => {
    await new Promise(resolve => setTimeout(resolve, 5));
    await context.assertCurrent();
    return { user: context.userId(request), cat: context.caller()?.catId };
  });
  const caller = (catId: string) => ({ catId, threadId: 'thread', userId: 'owner-'+catId, invocationId: 'inv-'+catId, assertCurrent: async () => { checks++; } });
  const responses = await Promise.all(['a','b'].map(cat => context.injectNative(caller(cat), { url: '/who' })));
  assert.deepEqual(responses.map(r=>r.json()), [{ user: 'owner-a', cat: 'a' }, { user: 'owner-b', cat: 'b' }]);
  assert.equal(checks, 4);
  await assert.rejects(context.injectNative({ ...caller('a'), assertCurrent: async () => { throw new Error('stale'); } }, { url: '/who' }), /stale/);
  assert.equal(context.caller(), null);
  await app.close();
});

test('SDK thread adapter uses authenticated scope and rejects forged user or stale invocation', async t => {
  const app = Fastify(); t.after(() => app.close());
  const scope = new CommunityRequestContext(app);
  const creations: string[] = [];
  const summary = { id: 'visible', deepLinkUrl: '/threads/visible', title: 'Title', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] };
  const threads = scope.threads({
    get: async id => id === 'visible' ? summary : null,
    create: async ({ title }) => { creations.push(title); return summary; },
  },memoryStorage());
  let live = true;
  app.post<{ Body: { userId: string; expire?: boolean } }>('/create', async request => {
    if (request.body.expire) live = false;
    return threads.create(request.body.userId, 'Community', 'case');
  });
  app.get('/read', async () => ({ visible: await threads.get('visible'), hidden: await threads.get('hidden') }));
  await assert.rejects(threads.create('owner', 'outside', 'case'), /Authenticated/);
  const caller = { catId: 'cat', userId: 'owner', threadId: 'thread', invocationId: 'inv', assertCurrent: async () => { if (!live) throw new Error('expired'); } };
  assert.equal((await scope.injectNative(caller, { method: 'POST', url: '/create', payload: { userId: 'forged' } })).statusCode, 500);
  assert.deepEqual(creations, []);
  assert.equal((await scope.injectNative(caller, { method: 'POST', url: '/create', payload: { userId: 'owner' } })).statusCode, 200);
  assert.deepEqual(creations, ['Community']);
  assert.equal((await scope.injectNative(caller, { method: 'POST', url: '/create', payload: { userId: 'owner', expire: true } })).statusCode, 500);
  assert.deepEqual(creations, ['Community']);
  const read = await scope.injectOwner({ kind: 'owner', id: 'owner' }, { url: '/read' });
  assert.deepEqual(read.json(), { visible: { id: 'visible', title: 'Title' }, hidden: null });
  scope.stop();
  await assert.rejects(threads.get('visible'), /stopped/);
});

test('lost ordinary Host create response permits recreation and saves its successful private case mapping', async t => {
  const app=Fastify();t.after(()=>app.close());const scope=new CommunityRequestContext(app),storage=memoryStorage();
  let created=0,lost=true;const rows=new Map<string,import('@clowder-ai/plugin-sdk').PluginThreadSummary>();
  const threads=scope.threads({get:async id=>rows.get(id)??null,create:async({title})=>{
    const id=String(++created),row={id,title,deepLinkUrl:'/threads/'+id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]};rows.set(id,row);
    if(lost){lost=false;throw new Error('response lost');}return row;
  }},storage);
  app.post('/create',async()=>threads.create('owner','Community','case-1'));const request={method:'POST',url:'/create'} as const;
  assert.equal((await scope.injectOwner({kind:'owner',id:'owner'},request)).statusCode,500);
  assert.equal((await scope.injectOwner({kind:'owner',id:'owner'},request)).statusCode,200);
  assert.equal(created,2);
  assert.equal((await scope.injectOwner({kind:'owner',id:'owner'},request)).json().id,'2');assert.equal(created,2);
});

test('embedded dispatch preserves the Host SDK async context as well as the package principal', async t => {
  const app = Fastify(); t.after(() => app.close());
  const scope = new CommunityRequestContext(app);
  const hostIdentity = new AsyncLocalStorage<string>();const createdThreads=new Map<string,import('@clowder-ai/plugin-sdk').PluginThreadSummary>();
  const threads = scope.threads({
    get: async id => createdThreads.get(id)??null,
    create: async () => {
      await new Promise(resolve => setImmediate(resolve));
      const user = hostIdentity.getStore();
      if (user !== scope.userId()) throw new Error('Host SDK context lost');
      const row={id:user!,deepLinkUrl:'/threads/'+user,title:null,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]};createdThreads.set(user!,row);return row;
    },
  },memoryStorage());
  app.post('/thread', async () => threads.create(scope.userId()!, 'Community', 'case'));
  const replies = await Promise.all(['a', 'b'].map(user => hostIdentity.run(user, () => scope.injectOwner({ kind: 'owner', id: user }, { method: 'POST', url: '/thread' }))));
  assert.deepEqual(replies.map(reply => ({ status: reply.statusCode, body: reply.json() })), [
    { status: 200, body: { id: 'a' } }, { status: 200, body: { id: 'b' } },
  ]);
  assert.equal(hostIdentity.getStore(), undefined);
});

test('point lookup finds a target that activity would move ahead of a live list cursor', async t => {
  const app = Fastify(); t.after(() => app.close()); const scope = new CommunityRequestContext(app);
  const rows = Array.from({ length: 51 }, (_, n) => ({ id: `t${String(n).padStart(3, '0')}`, title: `Thread ${n}`, deepLinkUrl: '/', createdAt: 1, lastActiveAt: 100 - n, preferredCats: [], featureRefs: [] }));
  let pages = 0, points = 0;
  const host = {
    get: async (id: string) => { points++; rows[50]!.lastActiveAt = 200; return rows.find(row => row.id === id) ?? null; },
    list: async (options?: { limit?: number; before?: { lastActiveAt: number; id: string } }) => {
      pages++;
      const page = rows.filter(row => !options?.before || row.lastActiveAt < options.before.lastActiveAt).sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 50);
      rows[50]!.lastActiveAt = 200;
      return page;
    },
    create: async () => { throw new Error('unused'); },
  };
  const threads = scope.threads(host,memoryStorage());
  app.get('/last', () => threads.get('t050'));
  const response = await scope.injectOwner({ kind: 'owner', id: 'owner' }, { url: '/last' });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { id: 't050', title: 'Thread 50' });
  assert.equal(points, 1); assert.equal(pages, 0);
});

for (const failure of ['expired', 'stopped'] as const) test(`point lookup rejects a result after request becomes ${failure}`, async t => {
  const app = Fastify(); t.after(() => app.close()); const scope = new CommunityRequestContext(app);
  let current = true, reads = 0;
  const threads = scope.threads({
    get: async id => {
      reads++;
      if (failure === 'expired') current = false; else scope.stop();
      return { id, title: 'Thread', deepLinkUrl: '/', createdAt: 1, lastActiveAt: 10, preferredCats: [], featureRefs: [] };
    },
    create: async () => { throw new Error('unused'); },
  },memoryStorage());
  app.get('/read', () => threads.get('target'));
  const response = await scope.injectNative({ catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => { if (!current) throw new Error('expired'); } }, { url: '/read' });
  assert.equal(response.statusCode, 500); assert.equal(reads, 1);
});
