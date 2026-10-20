import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorCommandService, type ConnectorCommandServices } from './connector-command-service.js';
import { parseConnectorCommand } from './connector-permissions.js';

function fixture() {
  const threads = [
    { id: 'first', deepLinkUrl: 'https://hub.example/thread/first', title: 'Latest', createdAt: 1, lastActiveAt: 30, featureRefs: ['F202'], preferredCats: ['cat-eqdvbcxw'] },
    { id: 'second', deepLinkUrl: 'https://hub.example/thread/second', title: 'Other project', createdAt: 2, lastActiveAt: 20, featureRefs: ['F080'], preferredCats: [] },
    { id: 'third', deepLinkUrl: 'https://hub.example/thread/third', title: 'Old Latest', createdAt: 3, lastActiveAt: 10, featureRefs: [], preferredCats: [] },
  ];
  let bound: string | undefined = 'first';
  const effects: unknown[] = [];
  const alice = { catId: 'cat-eqdvbcxw', displayName: '砚砚', aliases: ['@sol', '@缅因猫'] };
  const bob = { catId: 'opus', displayName: '宪宪', aliases: ['@opus', '@布偶猫'] };
  const unavailable = { catId: 'other', displayName: '另一猫', aliases: ['@缅因猫'] };
  const services: ConnectorCommandServices = {
    threads: {
      async findByKey() { return threads.find(t => t.id === bound) ?? null; },
      async get(id) { return threads.find(t => t.id === id) ?? null; },
      async create(input) { effects.push(['create', input.title]); return { id: 'new', deepLinkUrl: 'https://hub.example/thread/new', title: input.title, createdAt: 4, lastActiveAt: 40, preferredCats: [], featureRefs: [] }; },
      async bind(key, threadId) { effects.push(['bind', key, threadId]); bound = threadId; return { key, threadId, createdAt: 4 }; },
      async unbind(key) { effects.push(['unbind', key]); bound = undefined; return true; },
      async list() { effects.push(['list']); return threads; },
      async update(id, patch) { effects.push(['update', id, patch]); return threads.find(t => t.id === id)!; },
      async getCats(id) { effects.push(['cats', id]); return { participants: [{ ...alice, lastMessageAt: 20, messageCount: 3 }],
        routableNow: [alice], routableNotJoined: [bob], notRoutable: [unavailable] }; },
      async readMessages(id, options) { effects.push(['history', id, options.limit]); return [
        { id: 'm1', sender: { kind: 'owner' as const }, content: 'old question', timestamp: 1 },
        { id: 'm2', sender: { kind: 'cat' as const, catId: 'opus' }, content: 'old answer', timestamp: 2 },
        { id: 'm3', sender: { kind: 'owner' as const }, content: 'new question', timestamp: 3 },
        { id: 'm4', sender: { kind: 'system' as const }, content: 'system within round', timestamp: 4 },
        { id: 'm5', sender: { kind: 'cat' as const, catId: 'cat-eqdvbcxw' }, content: 'new answer', timestamp: 5 },
      ]; },
    },
    permissions: {
      async get() { return {v:1 as const,whitelistEnabled:false,commandAdminOnly:false,adminConfigured:true,adminOpenIds:['admin'],allowedGroups:[]}; },
      async allowGroup(id) { effects.push(['allow', id]); return { allowedGroups: [{ externalChatId: id }] }; },
      async denyGroup(id) { effects.push(['deny', id]); return false; },
    },
    async bindingChanged(change) { effects.push(['changed', change]); },
    now: () => 100,
    connectorId: 'feishu',
  };
  const execute = createConnectorCommandService(services);
  return { effects, services, clear: () => { bound = undefined; }, run: (text: string) => {
    const command = parseConnectorCommand(text); assert.ok(command);
    return execute(command, { chatId: 'chat', providerMessageId: 'event-1', group: false, senderId: 'admin', text });
  } };
}
test('where reads existing binding without creating a conversation', async () => {
  const f = fixture(); const result = await f.run('/where');
  assert.match(result.response, /Latest/); assert.match(result.response, /https:\/\/hub.example\/thread\/first/);
  assert.deepEqual(f.effects, []);
  f.clear(); assert.match((await f.run('/where')).response, /没有绑定/); assert.deepEqual(f.effects, []);
});
test('new creates then binds and reconciles subscriptions before declaring success', async () => {
  const f = fixture(); await f.run('/new Owner title');
  assert.deepEqual(f.effects, [['create', 'Owner title'], ['bind', 'chat', 'new'], ['changed', { chatId: 'chat', previousThreadId: 'first', threadId: 'new' }]]);
});
test('threads uses owner inventory including unbound threads and emits use controls', async () => {
  const f = fixture(); const result = await f.run('/threads');
  assert.match(result.response, /Other project/); assert.match(result.response, /F202/);
  assert.equal(result.cardActions?.[1]?.value.args, '2');
  assert.deepEqual(f.effects, [['list']]);
});
for (const [selector, expected] of [['F080', 'second'], ['2', 'second'], ['sec', 'second'], ['project', 'second'], ['Latest', 'first']]) {
  test(`use selection ${selector} preserves inventory selector precedence`, async () => {
    const f = fixture(); await f.run(`/use ${selector}`);
    assert.ok(f.effects.some(x => JSON.stringify(x) === JSON.stringify(['bind', 'chat', expected])));
  });
}
test('invalid use does not mutate the binding', async () => {
  const f = fixture(); assert.match((await f.run('/use nonexistent')).response, /找不到/);
  assert.deepEqual(f.effects, [['list']]);
});
test('thread binds then forwards only the explicit body, not the slash command', async () => {
  const f = fixture(); const result = await f.run('/thread sec hello owner');
  assert.deepEqual(result.forward, { threadId: 'second', text: 'hello owner' });
  assert.ok(f.effects.some(x => JSON.stringify(x) === JSON.stringify(['bind', 'chat', 'second'])));
});
test('commands lists all fourteen executable core commands and history pick control', async () => {
  const result = await fixture().run('/commands');
  for (const name of ['where', 'new', 'threads', 'use', 'thread', 'commands', 'cats', 'status', 'history', 'unbind', 'allow-group', 'deny-group', 'focus', 'ask']) assert.ok(result.response.includes(`/${name}`));
  assert.ok(result.cardActions?.some(x => x.value.cmd === '/history' && x.value.args === 'pick'));
});
test('unbind removes the mapping and reconciles the old subscription', async () => {
  const f = fixture(); await f.run('/unbind');
  assert.deepEqual(f.effects, [['unbind', 'chat'], ['changed', { chatId: 'chat', previousThreadId: 'first' }]]);
});
test('cats preserves Host classification, while status uses actual activity and preferred cats', async () => {
  const f = fixture(); const cats = await f.run('/cats');
  for (const value of ['砚砚', '宪宪', '另一猫', '3 条消息']) assert.ok(cats.response.includes(value));
  assert.match((await f.run('/status')).response, /参与猫：1/);
  assert.match((await f.run('/status')).response, /首选猫：砚砚/);
});
test('focus query is read-only and clear writes an actual empty preferredCats array', async () => {
  const f = fixture(); assert.match((await f.run('/focus')).response, /cat-eqdvbcxw/);
  assert.deepEqual(f.effects, []);
  await f.run('/focus clear');
  assert.deepEqual(f.effects, [['update', 'first', { preferredCats: [] }]]);
});
test('focus uses public alias projection and refuses ambiguity rather than choosing a cat', async () => {
  const f = fixture(); await f.run('/focus sol');
  assert.ok(f.effects.some(x => JSON.stringify(x) === JSON.stringify(['update', 'first', { preferredCats: ['cat-eqdvbcxw'] }])));
  const before = f.effects.length;
  assert.match((await f.run('/focus 缅因猫')).response, /多只/);
  assert.equal(f.effects.slice(before).some(x => Array.isArray(x) && x[0] === 'update'), false);
});
test('ask resolves aliases and forwards the explicit body to the current binding', async () => {
  const f = fixture(); assert.deepEqual((await f.run('/ask sol hello')).forward, { threadId: 'first', catId: 'cat-eqdvbcxw', text: 'hello' });
});
test('an exact unavailable cat never claims ask success or mutates preferredCats', async () => {
  const f = fixture();
  assert.equal((await f.run('/ask other hello')).forward, undefined);
  assert.match((await f.run('/focus other')).response, /不可调度/);
  assert.equal(f.effects.some(x => Array.isArray(x) && x[0] === 'update'), false);
});
test('history pick and invalid counts never read messages', async () => {
  const f = fixture(); const pick = await f.run('/history pick');
  assert.deepEqual(pick.cardActions?.map(x => x.value.args), ['1', '3', '5']);
  assert.match((await f.run('/history 9')).response, /用法/);
  assert.deepEqual(f.effects, []);
});
test('history reads bounded actual messages, excludes previous round, and retains system within the round', async () => {
  const f = fixture(); const result = await f.run('/history');
  assert.ok(result.response.includes('new question')); assert.ok(result.response.includes('system within round'));
  assert.ok(result.response.includes('new answer')); assert.equal(result.response.includes('old question'), false);
  assert.ok(f.effects.some(x => JSON.stringify(x) === JSON.stringify(['history', 'first', 200])));
});
test('history honors provider budget and links to the original thread when truncated', async () => {
  const f = fixture(); f.services.threads.readMessages = async () => [{ id: 'm', sender: { kind: 'owner' }, content: 'x'.repeat(30_000), timestamp: 5 }];
  const response = (await f.run('/history')).response;
  assert.ok(response.length <= 10_000); assert.match(response, /内容已精简/); assert.match(response, /https:\/\/hub.example\/thread\/first/);
});
test('commands needing a binding never silently create one', async () => {
  const f = fixture(); f.clear();
  for (const cmd of ['/cats', '/status', '/history', '/focus', '/ask sol hi', '/unbind']) assert.match((await f.run(cmd)).response, /没有绑定|未绑定/);
  assert.deepEqual(f.effects, []);
});
test('permission commands use the shared plugin CAS store without a Host-specific API', async () => {
  const f = fixture(); assert.match((await f.run('/allow-group group')).response, /共 1 个群/);
  assert.match((await f.run('/deny-group group')).response, /不在白名单/);
  assert.deepEqual(f.effects, [['allow', 'group'], ['deny', 'group']]);
});
test('use resolves title, feature and prefix beyond the first50 owner threads', async () => {
  for (const selector of ['Archived-Needle', 'F999', 'archived-']) {
    const f = fixture(); const rows = Array.from({ length: 51 }, (_, i) => ({
      id: i === 50 ? 'archived-id' : `recent-${i}`, title: i === 50 ? 'Archived-Needle' : 'Recent',
      deepLinkUrl: `https://hub.example/thread/item-${i}`, createdAt: 1, lastActiveAt: 100 - i, preferredCats: [], featureRefs: i === 50 ? ['F999'] : [] }));
    const calls: unknown[] = [];
    f.services.threads.list = async options => {
      calls.push(options);
      const before = (options as { before?: { lastActiveAt: number; id: string } } | undefined)?.before;
      return rows.filter(row => !before || row.lastActiveAt < before.lastActiveAt ||
        (row.lastActiveAt === before.lastActiveAt && row.id > before.id)).slice(0, options?.limit ?? 50);
    };
    await f.run(`/use ${selector}`);
    assert.ok(f.effects.some(x => JSON.stringify(x) === JSON.stringify(['bind', 'chat', 'archived-id'])));
    assert.deepEqual(calls, [{ limit: 50 }, { limit: 50, before: { lastActiveAt: 51, id: 'recent-49' } }]);
  }
});
test('an exact full page requests its empty tail; equal-time ordering uses JS strings', async () => {
  const f = fixture(); const rows = Array.from({ length: 50 }, (_, i) => ({ id: `T${String(i).padStart(2, '0')}`,
    deepLinkUrl: `https://hub.example/thread/item-${i}`, title: 'Recent', createdAt: 1, lastActiveAt: 10, preferredCats: [], featureRefs: [] }));
  rows[0]!.id = 'A'; rows[1]!.id = 'a'; rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let calls = 0;
  f.services.threads.list = async options => { calls++;
    const before = (options as { before?: { id: string } } | undefined)?.before;
    return rows.filter(row => !before || row.id > before.id); };
  await f.run('/use missing'); assert.equal(calls, 2);
  const recent = await f.run('/threads'); assert.equal(recent.cardActions?.[0]?.value.args, '1');
  assert.match(recent.response.split('\n')[2]!, /\[A\]/);
  assert.equal(calls, 3, 'recent ten needs one bounded page, not the entire inventory');
});
test('live pages deduplicate moved thread IDs; non-progressing cursor cannot loop or bind', async () => {
  const f = fixture(); const rows = Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`,
    deepLinkUrl: `https://hub.example/thread/item-${i}`, title: 'Recent', createdAt: 1, lastActiveAt: 100 - i, preferredCats: [], featureRefs: [] }));
  let calls = 0;
  f.services.threads.list = async () => ++calls === 1 ? rows : [{ ...rows[0]!, lastActiveAt: 40, title: 'Moved duplicate' }];
  assert.match((await f.run('/use Moved duplicate')).response, /找不到/, 'first projection wins for each id in this live traversal');
  assert.equal(f.effects.some(x => Array.isArray(x) && x[0] === 'bind'), false);
  f.services.threads.list = async () => rows;
  await assert.rejects(f.run('/use absent'), /cursor.*progress/i);
  assert.equal(f.effects.some(x => Array.isArray(x) && x[0] === 'bind'), false);
});
test('thread exact-ID lookup does not require a full inventory traversal', async () => {
  const f = fixture(); f.services.threads.list = async () => { throw new Error('inventory not needed'); };
  assert.deepEqual((await f.run('/thread second body')).forward, { threadId: 'second', text: 'body' });
});
test('an unfinished inventory budget refuses rather than binds a partial match or reports not-found', async () => {
  const f = fixture(); let calls = 0;
  f.services.threads.list = async () => {
    const page = calls++;
    return Array.from({ length: 50 }, (_, i) => ({ id: `item-${page}-${i}`, title: 'partial-match',
      deepLinkUrl: `https://hub.example/thread/item-${page}-${i}`, createdAt: 1, lastActiveAt: 100000 - page * 50 - i, preferredCats: [], featureRefs: [] }));
  };
  await assert.rejects(f.run('/use partial-match'), /traversal limit/);
  assert.equal(calls, 200);
  assert.equal(f.effects.some(x => Array.isArray(x) && x[0] === 'bind'), false);
});
