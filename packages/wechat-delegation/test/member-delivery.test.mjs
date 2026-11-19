import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { MemberRunner } from '../src/member-runner.mjs';
import { NativeLinkClient } from '../src/link-client.mjs';
import { NativeStdioTransport } from '../src/native-stdio.mjs';
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
  const child=spawn(process.execPath,[new URL('./fixtures/link-peer.mjs',import.meta.url).pathname,'delivery'],{env:{},stdio:['pipe','pipe','pipe'],shell:false});
  const write=child.stdin.write.bind(child.stdin);
  child.stdin.write=(bytes,...args)=>{
    const request=JSON.parse(bytes.toString('utf8'));
    if(request.method==='text.send')sends.push({body:{threadId:request.params.lease.destination,text:request.params.text},key:request.params.operationId,lease:request.params.lease});
    return write(bytes,...args);
  };
  const transport=new NativeStdioTransport(child);const client=new NativeLinkClient({transport,pid:child.pid,version:'0.1.0'});
  t.after(async()=>{transport.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');});
  await client.handshake();const identity=await client.identity('clowder');
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
  const policy = await service.activate({ accountId: 'clowder', accountIdentity: identity.accountIdentity, serverId: identity.serverId, nativeStoreId:identity.nativeStoreId, nativeLease:{accountGeneration:1,conversationGeneration:1,destination:conversationId}, conversationId, kind,
    catId: 'cat', persona: '自然友好', goal: '聊读书', proactive: true, replies: true, intervalMinutes: 60, maxTurns: 10, session });
  return { service, policy, sends, conversationId };
}

for (const kind of ['direct', 'group']) test(`signed canonical ${kind} responses reach the private stdio send contract for proactive and reply turns`, async t => {
  const f = await fixture(t, { kind });
  await f.service.initiate(f.policy.id, 'owner-request');
  assert.equal(f.sends.length, 1, 'the real MemberRunner must pass its canonical response into NativeLinkClient.submit');
  assert.deepEqual(f.sends[0].body, { threadId: f.conversationId, text });
  assert.equal((await f.service.snapshot()).runs[0].phase, 'accepted');
  await f.service.reconcile();
  assert.equal((await f.service.snapshot()).runs[0].phase, 'sent');
  await f.service.incoming('clowder', { id: 'inbound', threadId: f.conversationId, direction: 'incoming', body: '我也想读书', createdAt: 10001 });
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
