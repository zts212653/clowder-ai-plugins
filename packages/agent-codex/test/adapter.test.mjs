import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../src/index.mjs';

test('Codex exec binds its native identifier, streams once, forwards usage, and resumes over stdin', async () => {
  const { actions } = plugin.create().start();
  const records = [];
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      inspect: async () => ({ status: 'ready', version: '0.169.1' }),
      prepare: async () => ({}),
      async *run(plan) {
        records.push(plan);
        for (const value of [
          { type: 'thread.started', thread_id: 'native-thread' },
          { type: 'item.agent_message.delta', item_id: 'item-1', delta: 'hello' },
          { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'hello' } },
          { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 4, cached_input_tokens: 2 } },
        ]) yield { kind: 'record', value };
        yield { kind: 'exit', code: 0 };
      },
    },
  };
  assert.equal((await actions.detect({}, context)).candidates[0].state.version, '0.169.1');
  const sessionId = 'host-session';
  const open = await actions.openSession({ sessionId, instructions: 'identity' }, context);
  assert.deepEqual(open, { ok: true, binding: { state: 'pending_first_input' } });
  const first = await Array.fromAsync(actions.startTurn({ sessionId, invocationId: 'first', prompt: 'stdin secret' }, context));
  assert.deepEqual(first, [
    { type: 'native_bound', nativeSessionId: 'native-thread' },
    { type: 'output', text: 'hello' },
    { type: 'done', outcome: 'completed', messageUsage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 2 } },
  ]);
  assert.equal(records[0].stdin, 'stdin secret');
  assert.deepEqual(records[0].args, ['exec', '--json', '-c', 'developer_instructions="identity"', '--', '-']);
  await Array.fromAsync(actions.startTurn({ sessionId, invocationId: 'second', prompt: 'continue' }, context));
  assert.deepEqual(records[1].args.slice(0, 3), ['exec', 'resume', 'native-thread']);
  assert.deepEqual(actions.release({ sessionId }), { ok: true });
  await assert.rejects(Array.fromAsync(actions.startTurn({ sessionId, invocationId: 'released', prompt: '' }, context)), /unavailable/i);
});

test('Codex exec rejects an unapproved resume and requires a native terminal even on successful exit', async () => {
  const { actions } = plugin.create().start();
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      prepare: async () => ({ nativeSessionId: 'other-session' }),
      async *run() {
        yield { kind: 'exit', code: 0 };
      },
    },
  };
  const session = { sessionId: 'host-session', instructions: 'identity' };
  assert.equal((await actions.openSession({ ...session, resume: { nativeSessionId: 'expected' } }, context)).code, 'resume_unavailable');
  assert.equal((await actions.openSession(session, context)).ok, true);
  assert.deepEqual(await Array.fromAsync(actions.startTurn({ ...session, invocationId: 'empty', prompt: 'hello' }, context)), [
    { type: 'done', outcome: 'failed' },
  ]);
});
