import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { DelegationRuntime } from '../src/runtime.mjs';
import { NativeStdioTransport } from '../src/native-stdio.mjs';
import { NativeLinkClient } from '../src/link-client.mjs';

// Optional local integration target is the Rust libtest executable, never a
// live account binary. The selected ignored test has only synthetic peers and
// an in-memory test key store; all production Store/IPC/consumer code is real.
test('Host, MemberRunner and typed private pipes reach the real Rust Store for chat, switching, takeover and unknown sends',
  { skip: !process.env.WECHAT_NATIVE_TEST_BINARY, timeout: 20000 }, async t => {
  const child = spawn(process.env.WECHAT_NATIVE_TEST_BINARY, ['--exact', 'account_service::host_journey_fixture::serve_host_journey', '--ignored', '--nocapture'],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  let ending = false, diagnostics = '', wire = '';
  child.stdout.on('data', bytes => { diagnostics += bytes; });
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  child.stdio[4].on('data', bytes => { wire += bytes; });
  const frames = [], write = child.stdio[3].write.bind(child.stdio[3]);
  child.stdio[3].write = (bytes, ...args) => { frames.push(JSON.parse(String(bytes))); return write(bytes, ...args); };
  const privateChild = { stdin: child.stdio[3], stdout: child.stdio[4], stderr: child.stderr,
    once: child.once.bind(child), kill: () => { if (!ending) child.kill(); } };
  const transport = new NativeStdioTransport(privateChild, { timeoutMs: 3000 });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
  const client = new NativeLinkClient({ transport, pid: child.pid, version: '0.1.0' });
  await client.handshake();
  const rows = new Map(), sessions = new Map(), canonical = new Map(), executions = [];
  let sequence = 0;
  const host = { pluginInstanceId: 'native-host-journey', dataPath: '/unused-synthetic',
    storage: { get: async key => structuredClone(rows.get(key)), compareAndSet: async (key, revision, value) => {
      const old = rows.get(key); if ((old?.revision ?? null) !== revision) return { applied: false };
      rows.set(key, { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }); return { applied: true };
    } },
    members: { list: async () => ['cat-a', 'cat-b'].map(catId => ({ catId, displayName: catId, available: true })) },
    threads: { list: async () => [], get: async id => ({ id }) },
    messaging: { get: async id => canonical.get(id), subscribe: async () => {}, unsubscribe: async () => {} },
    memberSessions: {
      describe: async () => ({ available: true, runtime: { clientId: 'synthetic', model: 'fixture' }, accounts: [] }),
      ensureThread: async ({ catId }) => ({ threadId: `isolated-${catId}` }),
      prepare: async input => {
        assert.deepEqual(input.memory, []);
        const grant = { sessionId: `session-${++sequence}`, generation: 1, catId: input.catId, threadId: input.threadId,
          ownerUserId: 'owner', consumedCursor: 0, revoked: false, runtime: { clientId: 'synthetic', model: 'fixture' } };
        sessions.set(grant.sessionId, grant); return structuredClone(grant);
      },
      get: async id => structuredClone(sessions.get(id)),
      revoke: async id => { sessions.get(id).revoked = true; },
      getExecution: async () => { throw Error('fixture completes synchronously'); },
      execute: async input => {
        executions.push(structuredClone(input));
        const grant = sessions.get(input.sessionId), messageId = `canonical:${input.executionId}`;
        const prompt = JSON.parse(input.content);
        const text = prompt.externalMessage ? '好，一起读书。' : '周末一起读书吗？';
        canonical.set(messageId, { id: messageId, threadId: grant.threadId, userId: 'owner', catId: grant.catId,
          content: JSON.stringify({ kind: 'message', text }) });
        return { executionId: input.executionId, phase: 'succeeded', responseMessageId: messageId };
      },
    },
  };
  const supervisor = { client: null, prepare: async () => (supervisor.client = client),
    stopOwned: async active => { if (supervisor.client === active) supervisor.client = null; }, stop: async () => { supervisor.client = null; } };
  const runtime = await DelegationRuntime.open(host, { supervisor, startTimer: false });
  t.after(() => runtime.stop());
  const owner = { kind: 'owner-http-request', userId: 'owner', pluginInstanceId: host.pluginInstanceId, operation: 'write',
    requestIdentity: { requestId: 'synthetic-owner' }, signal: new AbortController().signal, assertCurrent: async () => {} };
  await runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner); await runtime.drain();
  await runtime.cycle(); await runtime.drain();
  let directory;
  for (let i = 0; i < 16; i++) {
    directory = await client.targets('clowder'); if (!directory.pending) break;
    await client.directory.current.job;
  }
  assert.equal(directory.pending, false);
  assert.equal(directory.items.length, 2);
  const activate = async (id, kind, catId) => {
    const identity = await client.identity('clowder'), preview = await runtime.dispatch({ action: 'cat_details', catId }, owner);
    const old = (await runtime.service.snapshot()).policies.find(p => p.conversationId === id);
    await runtime.dispatch({ action: 'activate', serverId: identity.serverId, accountIdentity: identity.accountIdentity,
      target: { id, kind }, catId, persona: '自然友好', goal: '一起读书', proactive: true, replies: true,
      intervalMinutes: 180, maxTurns: 10, confirm: true, expectedEpoch: old?.epoch ?? 0, modelFingerprint: preview.fingerprint }, owner);
    return (await runtime.service.snapshot()).policies.find(p => p.conversationId === id);
  };
  const initiate = async (policy, operationId) => {
    await runtime.dispatch({ action: 'initiate', policyId: policy.id, operationId }, owner); await runtime.drain();
  };
  let friend = await activate('friend', 'direct', 'cat-a');
  await initiate(friend, 'friend-first');
  await runtime.cycle(); await runtime.drain(); // canonical echo + one incoming reply
  await runtime.cycle(); await runtime.drain(); // canonical echo for that reply
  assert.ok(executions.some(input => JSON.parse(input.content).externalMessage === '一起读书吧'));
  assert.equal((await runtime.service.snapshot()).runs.filter(r => r.trigger === 'reply').length, 1);
  friend = await activate('friend', 'direct', 'cat-b');
  await initiate(friend, 'friend-cat-switch');
  assert.equal(sessions.get(executions.at(-1).sessionId).catId, 'cat-b');
  const admitted = frames.filter(frame => frame.method === 'text.send').at(-1).params;
  await runtime.dispatch({ action: 'takeover', policyId: friend.id }, owner); await runtime.drain();
  await assert.rejects(transport.request('text.send', { ...admitted, operationId: 'stale-after-takeover' }));
  await assert.rejects(initiate(friend, 'after-takeover'), /paused|inactive/);
  const group = await activate('room@chatroom', 'group', 'cat-a');
  await initiate(group, 'group-unknown');
  const before = frames.filter(frame => frame.method === 'text.send').length;
  await runtime.cycle(); await runtime.drain();
  const unknown = (await runtime.service.snapshot()).runs.find(run => run.operationId === 'group-unknown');
  assert.equal(unknown.phase, 'needs_review');
  await assert.rejects(initiate(group, 'group-no-resend'));
  assert.equal(frames.filter(frame => frame.method === 'text.send').length, before);
  await runtime.dispatch({ action: 'takeover', policyId: group.id }, owner); await runtime.drain();
  const visible = JSON.stringify({ rows: [...rows], executions, canonical: [...canonical], status: await runtime.status() }) + wire;
  for (const secret of ['PRIVATE_ACCOUNT_CANARY', 'PRIVATE_SYNC_CANARY', 'PRIVATE_TRANSPORT_CANARY',
    JSON.stringify([...Buffer.from('PRIVATE_ACCOUNT_CANARY')])]) assert.equal(visible.includes(secret), false);
  assert.equal(executions.every(input => !Object.keys(input).some(key => /token|cookie|key|credential|qr/i.test(key))), true);
  await runtime.stop(); ending = true; privateChild.stdin.end();
  const [code, signal] = await exit;
  assert.equal(code, 0, diagnostics); assert.equal(signal, null);
  assert.match(diagnostics, /1 passed/);
});
