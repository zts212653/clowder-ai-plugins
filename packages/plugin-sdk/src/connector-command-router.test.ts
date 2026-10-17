import assert from 'node:assert/strict';
import test from 'node:test';
import { routeConnectorCommand, createConnectorCommandRouter, executeConnectorPermissionCommand } from './connector-command-router.js';
import { decodeLegacyConnectorPermissions } from './connector-permissions.js';

const policy = decodeLegacyConnectorPermissions({ config: {
  whitelistEnabled: 'true', commandAdminOnly: 'true', adminOpenIds: '["admin"]',
}, groups: { allowed: '{"addedAt":10}' } });
const direct = { chatId: 'direct', providerMessageId: 'event-1', group: false, senderId: 'admin', text: '/where' };
function fixture() {
  const calls: string[] = [];
  return { calls, ports: {
    async getPermissions() { calls.push('permissions'); return policy; },
    async execute(command: { name: string }) { calls.push(`execute:${command.name}`); return { response: 'reply' }; },
    async reply(_chatId: string, text: string) { calls.push(`reply:${text}`); },
    async audit(_input: unknown, _response: string) { calls.push('audit'); },
    async forward(_input: unknown, _body: unknown) { calls.push('forward'); },
    async settle(_input: unknown) { calls.push('settle'); },
  } };
}
test('every recognized slash is intercepted; only command body forwarding is opt-in', async () => {
  for (const name of ['where', 'new', 'threads', 'use', 'thread', 'commands', 'cats', 'status', 'history', 'unbind', 'allow-group', 'deny-group', 'focus', 'ask']) {
    const { calls, ports } = fixture();
    assert.equal(await routeConnectorCommand({ ...direct, text: `/${name}` }, ports), 'command');
    assert.deepEqual(calls, ['permissions', `execute:${name}`, 'reply:reply', 'audit', 'settle']);
  }
});
test('ordinary messages and unknown commands pass through only after permission checks', async () => {
  for (const text of ['hello', '/unknown']) {
    const { calls, ports } = fixture();
    assert.equal(await routeConnectorCommand({ ...direct, text }, ports), 'message');
    assert.deepEqual(calls, ['permissions']);
  }
});
test('denied group has zero command/audit/forward effects', async () => {
  const { calls, ports } = fixture();
  assert.equal(await routeConnectorCommand({ ...direct, chatId: 'blocked', group: true }, ports), 'blocked');
  assert.deepEqual(calls, ['permissions', 'reply:🔒 此群未在白名单中，请联系管理员。', 'settle']);
});
test('missing sender cannot bypass admin-only guard in an allowed group', async () => {
  const { calls, ports } = fixture();
  assert.equal(await routeConnectorCommand({ text: '/where', providerMessageId: 'event-1', chatId: 'allowed', group: true }, ports), 'blocked');
  assert.equal(calls.some(call => call.startsWith('execute:')), false);
});

test('provider replay is fenced before concurrent command mutation and permission side effects', async () => {
  const { calls, ports } = fixture();
  const route = createConnectorCommandRouter(ports);
  const results = await Promise.all([route({ ...direct, text: '/new' }), route({ ...direct, text: '/new' })]);
  assert.deepEqual(results.sort(), ['command', 'duplicate']);
  assert.equal(calls.filter(call => call === 'execute:new').length, 1);
  assert.equal(calls.filter(call => call === 'settle').length, 1);
});
test('permission initialization failure does not consume the provider event before an owner import', async () => {
  const { calls, ports } = fixture(); let ready = false;
  ports.getPermissions = async () => { if (!ready) throw new Error('not initialized'); return policy; };
  const route = createConnectorCommandRouter(ports);
  await assert.rejects(route(direct), /not initialized/);
  ready = true;
  assert.equal(await route(direct), 'command');
  assert.equal(calls.filter(value => value === 'execute:where').length, 1);
});
test('runtime dedup is bounded, chat-specific and rejects absent provider event identity', async () => {
  const { calls, ports } = fixture();
  const route = createConnectorCommandRouter(ports, 2);
  await route(direct);
  await route({ ...direct, chatId: 'second' });
  assert.equal(await route({ ...direct, providerMessageId: 'event-2' }), 'command');
  assert.equal(await route(direct), 'command', 'oldest entry is evicted at the existing runtime bound');
  const before = calls.length;
  await assert.rejects(route({ ...direct, providerMessageId: '' }), /event identity/);
  assert.equal(calls.length, before);
});

test('failed ordinary delivery remains retryable, while failed command mutation stays fenced', async () => {
  const { ports } = fixture();
  const route = createConnectorCommandRouter(ports); let deliveries = 0;
  const ordinary = { ...direct, text: 'photo' };
  await assert.rejects(route(ordinary, async () => { deliveries++; throw new Error('Host indeterminate'); }), /indeterminate/);
  assert.equal(await route(ordinary, async () => { deliveries++; }), 'message');
  assert.equal(await route(ordinary, async () => { deliveries++; }), 'duplicate');
  assert.equal(deliveries, 2);
  ports.execute = async () => { throw new Error('mutation indeterminate'); };
  await assert.rejects(route({ ...direct, providerMessageId: 'command' }), /indeterminate/);
  assert.equal(await route({ ...direct, providerMessageId: 'command' }), 'duplicate');
});

test('late failure of an evicted ordinary claim cannot release its newer retry claim', async () => {
  const { ports } = fixture(); const route = createConnectorCommandRouter(ports, 1);
  let rejectOld!: (error: Error) => void; let resolveNew!: () => void;
  let signalOld!: () => void; let signalNew!: () => void;
  const oldStarted = new Promise<void>(resolve => { signalOld = resolve; });
  const newStarted = new Promise<void>(resolve => { signalNew = resolve; });
  const ordinary = { ...direct, text: 'photo' };
  const old = route(ordinary, () => { signalOld(); return new Promise<void>((_resolve, reject) => { rejectOld = reject; }); });
  const failed = assert.rejects(old, /old failure/);
  await oldStarted;
  await route({ ...direct, providerMessageId: 'evicts-old' });
  const newer = route(ordinary, () => { signalNew(); return new Promise<void>(resolve => { resolveNew = resolve; }); });
  await newStarted;
  rejectOld(new Error('old failure')); await failed;
  assert.equal(await route(ordinary), 'duplicate');
  resolveNew(); await newer;
});
test('a command handler failure never becomes ordinary ingress', async () => {
  const { calls, ports } = fixture();
  ports.execute = async () => { throw new Error('unavailable'); };
  await assert.rejects(routeConnectorCommand(direct, ports), /unavailable/);
  assert.deepEqual(calls, ['permissions']);
});
test('invalid provider facts and unexpected forwarding fail without reply, audit or ordinary delivery', async () => {
  const { calls, ports } = fixture();
  await assert.rejects(routeConnectorCommand({ ...direct, group: undefined as unknown as boolean }, ports), /provider/);
  assert.deepEqual(calls, []);
  ports.execute = async () => ({ response: 'reply', forward: { threadId: 'thread', text: 'injected body' } });
  await assert.rejects(routeConnectorCommand(direct, ports), /only ask\/thread/);
  assert.deepEqual(calls, ['permissions']);
});
test('ask/thread success reply and quiet audit follow accepted explicit forwarding', async () => {
  const { calls, ports } = fixture();
  ports.execute = async () => ({ response: 'reply', forward: { text: 'body', threadId: 'thread', catId: 'cat-eqdvbcxw' } });
  assert.equal(await routeConnectorCommand({ ...direct, text: '/ask sol body' }, ports), 'command');
  assert.deepEqual(calls, ['permissions', 'forward', 'reply:reply', 'audit']);
});
test('explicit forward failure cannot emit or audit a false success response', async () => {
  const { calls, ports } = fixture();
  ports.execute = async () => ({ response: '已定向发送', forward: { text: 'body', threadId: 'thread' } });
  ports.forward = async () => { calls.push('forward'); throw new Error('Host effect unconfirmed'); };
  const route = createConnectorCommandRouter(ports);
  await assert.rejects(route({ ...direct, text: '/ask sol body' }), /unconfirmed/);
  assert.deepEqual(calls, ['permissions', 'forward']);
  assert.equal(await route({ ...direct, text: '/ask sol body' }), 'duplicate', 'do not retry ambiguous external effects');
});
test('pending forwarding emits no success and does not settle the provider task', async () => {
  const { calls, ports } = fixture(); let accepted!: () => void; let started!: () => void;
  const pending = new Promise<void>(resolve => { accepted = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  ports.execute = async () => ({ response: '已定向发送', forward: { text: 'body', threadId: 'thread' } });
  ports.forward = async () => { calls.push('forward'); started(); await pending; };
  const routed = routeConnectorCommand({ ...direct, text: '/ask sol body' }, ports);
  await entered; assert.deepEqual(calls, ['permissions', 'forward']);
  accepted(); await routed;
  assert.deepEqual(calls, ['permissions', 'forward', 'reply:已定向发送', 'audit']);
});
test('a failed acknowledgement or audit cannot resend an already accepted body', async () => {
  for (const stage of ['reply', 'audit'] as const) {
    const { calls, ports } = fixture();
    ports.execute = async () => ({ response: '已定向发送', forward: { text: 'body', threadId: 'thread' } });
    ports[stage] = async () => { calls.push(`failed:${stage}`); throw new Error('side effect unconfirmed'); };
    const route = createConnectorCommandRouter(ports);
    await assert.rejects(route({ ...direct, text: '/ask sol body' }), /unconfirmed/);
    assert.equal(await route({ ...direct, text: '/ask sol body' }), 'duplicate');
    assert.equal(calls.filter(call => call === 'forward').length, 1);
    assert.equal(calls.includes('settle'), false);
  }
});
test('allow/deny-group enforce admin identity even in a direct conversation', async () => {
  let effects = 0;
  const store = { async allowGroup() { effects++; return { allowedGroups: [] }; }, async denyGroup() { effects++; return false; } };
  for (const name of ['allow-group', 'deny-group'] as const) {
    for (const senderId of [undefined, 'guest']) {
      const result = await executeConnectorPermissionCommand({ name, args: '' }, { chatId: 'direct', senderId }, policy, store);
      assert.match(result.response, /仅管理员/);
    }
  }
  assert.equal(effects, 0);
});
test('admin allow/deny use the explicit chat or current chat and return truthful mutation results', async () => {
  const calls: string[] = [];
  const store = { async allowGroup(id: string) { calls.push(`allow:${id}`); return { allowedGroups: [{ externalChatId: id }] }; }, async denyGroup(id: string) { calls.push(`deny:${id}`); return false; } };
  await executeConnectorPermissionCommand({ name: 'allow-group', args: 'target' }, direct, policy, store);
  const denied = await executeConnectorPermissionCommand({ name: 'deny-group', args: '' }, direct, policy, store);
  assert.deepEqual(calls, ['allow:target', 'deny:direct']);
  assert.match(denied.response, /不在白名单/);
});
