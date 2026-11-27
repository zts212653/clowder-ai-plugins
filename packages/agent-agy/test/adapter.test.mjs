import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin from '../src/index.mjs';

const fixtureDir = process.env.CLOWDER_AGY_NATIVE_FIXTURES;
const nativeSessionId = 'fixture-native-1';
const initial = {
  event: 'init',
  init: { tools: [], permission_mode: 'DEFAULT' },
};
const result = (conversationId, response, denied = []) => ({
  event: 'result',
  result: {
    conversation_id: conversationId,
    status: 'SUCCESS',
    response,
    denied_actions: denied,
  },
});

test('Antigravity qualifies one conversation and resumes through the NDJSON port', async () => {
  const { actions } = plugin.create().start();
  const launches = [];
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      prepare: async ({ resumeNativeSessionId }) => ({
        agentFile: join('profile', 'cat-agent', 'agent.md'),
        nativeSessionId: resumeNativeSessionId,
      }),
      async *run(input) {
        launches.push(input);
        for (const value of [
          initial,
          result(nativeSessionId, 'fixture output'),
        ])
          yield { kind: 'record', value };
        yield { kind: 'exit', code: 0 };
      },
    },
  };
  const session = {
    sessionId: 'first',
    instructions: 'fixture L0',
    model: 'fixture-model',
  };
  assert.equal((await actions.openSession(session, context)).ok, true);
  const first = await Array.fromAsync(
    actions.startTurn(
      { ...session, invocationId: 'one', prompt: 'hello' },
      context,
    ),
  );
  assert.deepEqual(first, [
    { type: 'native_bound', nativeSessionId },
    { type: 'output', text: 'fixture output' },
    { type: 'done', outcome: 'completed' },
  ]);
  assert.deepEqual(JSON.parse(launches[0].stdin), {
    event: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  assert.ok(!launches[0].args.includes('--conversation'));
  assert.deepEqual(actions.release({ sessionId: 'first' }), { ok: true });
  const resumed = {
    ...session,
    sessionId: 'resumed',
    resume: { nativeSessionId },
  };
  assert.deepEqual(await actions.openSession(resumed, context), {
    ok: true,
    binding: { state: 'bound', nativeSessionId },
  });
  await Array.fromAsync(
    actions.startTurn(
      { ...resumed, invocationId: 'two', prompt: 'continue' },
      context,
    ),
  );
  assert.deepEqual(launches[1].args.slice(-2), [
    '--conversation',
    nativeSessionId,
  ]);

  context.nativeRuntime.run = async function* () {
    yield {
      kind: 'record',
      value: result('unrelated-session', 'must not escape'),
    };
  };
  await assert.rejects(
    Array.fromAsync(
      actions.startTurn(
        { ...resumed, invocationId: 'foreign', prompt: 'continue' },
        context,
      ),
    ),
    /Unexpected Antigravity native session/,
  );
});

for (const [fixture, outcome, errorCode] of [
  ['resume-turn', 'completed', undefined],
  ['denied-mcp-turn', 'failed', 'native_permission_denied'],
]) {
  test(
    'replays captured native Antigravity output ' + fixture,
    { skip: !fixtureDir },
    async () => {
      const events = readFileSync(join(fixtureDir, fixture + '.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      const { actions } = plugin.create().start();
      const context = {
        signal: new AbortController().signal,
        nativeRuntime: {
          prepare: async () => ({
            agentFile: join('profile', 'cat-agent', 'agent.md'),
          }),
          async *run() {
            for (const value of events) yield { kind: 'record', value };
            yield { kind: 'exit', code: 0 };
          },
        },
      };
      const session = { sessionId: 'replay', instructions: 'fixture L0' };
      assert.equal((await actions.openSession(session, context)).ok, true);
      const observed = await Array.fromAsync(
        actions.startTurn(
          { ...session, invocationId: 'test', prompt: 'hello' },
          context,
        ),
      );
      assert.equal(observed.at(-1).outcome, outcome);
      assert.equal(observed.at(-1).errorCode, errorCode);
      assert.equal(
        observed.some((entry) => entry.type === 'output'),
        outcome === 'completed',
      );
    },
  );
}
