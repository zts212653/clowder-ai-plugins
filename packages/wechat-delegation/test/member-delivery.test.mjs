import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MemberRunner } from '../src/member-runner.mjs';
import { NativeClient } from '../src/native-client.mjs';
import { DelegationService } from '../src/service.mjs';

const text = '周末一起读书吗？\n书名是《{未来}》，有空再聊。';
// The real family runtime appends this presentation suffix to its canonical
// response even when the member instruction asks for an unadorned JSON object.
const signed = JSON.stringify({ kind: 'message', text }) + '\n\n[砚砚/gpt-6.1-sol🐾]';

async function fixture(t, { kind = 'direct', content = signed, foreign = false } = {}) {
  const sends = [];
  const conversationId = kind === 'group' ? 'room@chatroom' : 'friend';
  const session = { sessionId: 'session', generation: 1, threadId: 'isolated', catId: 'cat', ownerUserId: 'owner', revoked: false };
  const model = new MemberRunner({
    memberSessions: {
      get: async () => session,
      execute: async input => ({ executionId: input.executionId, phase: 'succeeded', responseMessageId: 'canonical' }),
    },
    messaging: { get: async () => ({ id: 'canonical', threadId: foreign ? 'other-thread' : session.threadId,
      catId: session.catId, userId: session.ownerUserId, content }) },
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const reply = value => response.end(JSON.stringify(value));
    if (request.url === '/v1/status') return reply({ serverId: 'server', version: { product: 'agent-wechat', backend: 'native', apiVersion: 1 } });
    if (request.url === '/v1/accounts/account') return reply({ id: 'account', ownUsername: 'owner', authenticated: true, connection: 'online' });
    const receipt = { id: 'send', accountId: 'account', destination: conversationId, state: 'accepted', localMessageId: 'local', serverId: '123' };
    if (request.url === '/v1/accounts/account/sends' && request.method === 'POST') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      sends.push({ body: JSON.parse(raw), key: request.headers['idempotency-key'] });
      return reply(receipt);
    }
    if (request.url === '/v1/accounts/account/sends/send') return reply(receipt);
    if (request.url === '/v1/accounts/account/messages/local') return reply({ id: 'local', accountId: 'account', threadId: conversationId,
      direction: 'outgoing', serverId: '123', body: sends.at(-1).body.text });
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new NativeClient({ baseUrl: `http://127.0.0.1:${server.address().port}/`, token: 'a'.repeat(64) });
  let row;
  const storage = {
    get: async () => structuredClone(row),
    compareAndSet: async (_key, expected, value) => {
      if ((row?.revision ?? null) !== expected) return { applied: false };
      row = { revision: (row?.revision ?? 0) + 1, value: structuredClone(value) };
      return { applied: true, revision: row.revision };
    },
  };
  const channel = Object.fromEntries(['prepare', 'submit', 'inspect', 'cancel'].map(method => [method, client[method].bind(client)]));
  const service = await DelegationService.open({ storage, channel, model, now: () => 10000 });
  const policy = await service.activate({ accountId: 'account', accountIdentity: 'owner', serverId: 'server', conversationId, kind,
    catId: 'cat', persona: '自然友好', goal: '聊读书', proactive: true, replies: true, intervalMinutes: 60, maxTurns: 10, session });
  return { service, policy, sends, conversationId };
}

for (const kind of ['direct', 'group']) test(`signed canonical ${kind} responses reach the native HTTP send contract for proactive and reply turns`, async t => {
  const f = await fixture(t, { kind });
  await f.service.initiate(f.policy.id, 'owner-request');
  assert.equal(f.sends.length, 1, 'the real MemberRunner must pass its canonical response into NativeClient.submit');
  assert.deepEqual(f.sends[0].body, { threadId: f.conversationId, text });
  assert.equal((await f.service.snapshot()).runs[0].phase, 'accepted');
  await f.service.reconcile();
  assert.equal((await f.service.snapshot()).runs[0].phase, 'sent');
  await f.service.incoming('account', { id: 'inbound', threadId: f.conversationId, direction: 'incoming', body: '我也想读书', createdAt: 10001 });
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[1].body, { threadId: f.conversationId, text });
  await f.service.reconcile();
  const state = await f.service.snapshot();
  assert.ok(state.runs.every(run => run.phase === 'sent' && run.submitted));
  assert.deepEqual(f.sends.map(send => send.key), state.runs.map(run => run.id));
  await f.service.initiate(f.policy.id, 'owner-request');
  assert.equal(f.sends.length, 2, 'the original operation must not be resent');
});

test('a family signature inside the message text is removed before persistence, sending and receipt reconciliation', async t => {
  for (const kind of ['direct', 'group']) {
    const content = JSON.stringify({ kind: 'message', text: text + '\r\n\r\n[砚砚/gpt-6.1-sol🐾]\r\n' }) + '\n\n[砚砚/gpt-6.1-sol🐾]';
    const f = await fixture(t, { kind, content });
    await f.service.initiate(f.policy.id, 'unsigned-message');
    assert.deepEqual(f.sends.map(send => send.body), [{ threadId: f.conversationId, text }]);
    assert.equal((await f.service.snapshot()).runs[0].text, text);
    await f.service.reconcile();
    assert.equal((await f.service.snapshot()).runs[0].phase, 'sent');
  }
});

test('signature removal keeps ordinary message content intact and refuses a signature-only message', async t => {
  const literal = '例子是[作者/模型🐾]，这段是正文。\n[读书会]';
  const f = await fixture(t, { content: JSON.stringify({ kind: 'message', text: literal }) });
  await f.service.initiate(f.policy.id, 'literal-content');
  assert.equal(f.sends[0].body.text, literal);
  const empty = await fixture(t, { content: JSON.stringify({ kind: 'message', text: '[砚砚/gpt-6.1-sol🐾]' }) });
  await empty.service.initiate(empty.policy.id, 'signature-only');
  assert.equal(empty.sends.length, 0);
  assert.equal((await empty.service.snapshot()).runs[0].errorCode, 'member_response_format');
});

test('unsupported canonical output stays unsent and exposes a bounded format failure instead of forwarding arbitrary text', async t => {
  for (const content of ['普通文字', signed + '\n另一段说明', '{"kind":"message","text":"一"}\n{"kind":"message","text":"二"}',
    '{"kind":"message","text":"正文","recipient":"other"}', '{"kind":"message","text":" "}']) {
    const f = await fixture(t, { content });
    await f.service.initiate(f.policy.id, 'invalid-output');
    assert.equal(f.sends.length, 0);
    const state = await f.service.snapshot();
    assert.equal(state.runs[0].submitted, false);
    assert.equal(state.runs[0].phase, 'failed');
    assert.equal(state.policies[0].mode, 'paused');
    assert.equal(state.runs[0].errorCode, 'member_response_format');
    assert.match(state.runs[0].error, /回复格式.*未提交微信发送/);
    assert.ok(!state.runs[0].error.includes(content));
  }
});

test('a signed response from another thread still fails identity verification before the native send', async t => {
  const f = await fixture(t, { foreign: true });
  await f.service.initiate(f.policy.id, 'foreign-response');
  assert.equal(f.sends.length, 0);
  assert.equal((await f.service.snapshot()).runs[0].phase, 'failed');
});

test('signed owner handoffs and silence remain control results and never become WeChat text', async t => {
  for (const [kind, phase] of [['needs_owner', 'needs_owner'], ['silent', 'silent']]) {
    const f = await fixture(t, { content: JSON.stringify({ kind, text: '本轮到此为止' }) + '\n\n[验收猫/模拟模型🐾]' });
    await f.service.initiate(f.policy.id, 'control-result');
    assert.equal(f.sends.length, 0);
    assert.equal((await f.service.snapshot()).runs[0].phase, phase);
  }
});
