import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../src/index.mjs';

test('DSH requests a startup system identity instead of prepending it to the user prompt', async () => {
  const { actions } = plugin.create().start();
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      acp: {
        async open({ hostSessionId, resumeNativeSessionId, startup }) {
          assert.equal(hostSessionId, 'host');
          assert.equal(resumeNativeSessionId, 'native');
          assert.equal(startup.config.body, 'identity');
          assert.match(
            startup.config.marker,
            /^<!-- clowder-l0:[a-f0-9]{64} -->$/,
          );
          assert.match(startup.moduleUrl, /\/dsh-l0-series\.mjs$/);
          return { ok: true, nativeSessionId: 'native' };
        },
        async *prompt(input) {
          assert.deepEqual(input, {
            hostSessionId: 'host',
            prompt: 'new message',
          });
          yield {
            kind: 'update',
            update: {
              sessionId: 'native',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'reply' },
              },
            },
          };
          yield {
            kind: 'update',
            update: {
              sessionId: 'native',
              update: { sessionUpdate: 'usage_update', used: 12, size: 50 },
            },
          };
          yield {
            kind: 'terminal',
            stopReason: 'end_turn',
            finalResponse: true,
          };
        },
      },
    },
  };
  assert.equal(actions.describe().capabilities.quota.status, 'unsupported');
  const input = {
    sessionId: 'host',
    instructions: 'identity',
    resume: { nativeSessionId: 'native' },
  };
  assert.deepEqual(await actions.openSession(input, context), {
    ok: true,
    binding: { state: 'bound', nativeSessionId: 'native' },
  });
  assert.deepEqual(
    await Array.fromAsync(
      actions.startTurn(
        {
          sessionId: 'host',
          invocationId: 'one',
          prompt: 'new message',
        },
        context,
      ),
    ),
    [
      { type: 'output', text: 'reply' },
      {
        type: 'done',
        outcome: 'completed',
        messageUsage: {
          contextUsedTokens: 12,
          lastTurnInputTokens: 12,
          contextWindowSize: 50,
        },
      },
    ],
  );
});

test('DSH releases a wrong resume binding and requires a final native prompt response', async () => {
  const { actions } = plugin.create().start();
  const closed = [];
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      acp: {
        async open() {
          return { ok: true, nativeSessionId: 'actual' };
        },
        async release(id) {
          closed.push(id);
        },
        async *prompt() {
          yield {
            kind: 'terminal',
            stopReason: 'end_turn',
            finalResponse: false,
          };
        },
      },
    },
  };
  const input = { sessionId: 'host', instructions: 'identity' };
  assert.equal(
    (
      await actions.openSession(
        { ...input, resume: { nativeSessionId: 'other' } },
        context,
      )
    ).code,
    'resume_unavailable',
  );
  assert.deepEqual(closed, ['host']);
  assert.equal((await actions.openSession(input, context)).ok, true);
  const output = await Array.fromAsync(
    actions.startTurn(
      { sessionId: 'host', invocationId: 'test', prompt: 'hello' },
      context,
    ),
  );
  assert.deepEqual(output, [{ type: 'done', outcome: 'failed' }]);
});

test('DSH cancels only the requested turn and never completes it successfully', async () => {
  const { actions } = plugin.create().start();
  const cancelled = [];
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: {
      acp: {
        async open() {
          return { ok: true, nativeSessionId: 'native' };
        },
        async *prompt() {
          yield {
            kind: 'update',
            update: {
              sessionId: 'native',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'prefix' },
              },
            },
          };
          yield {
            kind: 'terminal',
            stopReason: 'end_turn',
            finalResponse: true,
          };
        },
        async cancel(id) {
          cancelled.push(id);
          return true;
        },
      },
    },
  };
  assert.equal(
    (
      await actions.openSession(
        { sessionId: 'host', instructions: 'identity' },
        context,
      )
    ).ok,
    true,
  );
  const turn = actions.startTurn(
    { sessionId: 'host', invocationId: 'expected', prompt: 'hello' },
    context,
  );
  assert.deepEqual((await turn.next()).value, {
    type: 'output',
    text: 'prefix',
  });
  assert.deepEqual(
    await actions.cancel({ sessionId: 'host', invocationId: 'stale' }, context),
    {
      ok: false,
      code: 'turn_ended',
    },
  );
  assert.deepEqual(
    await actions.cancel(
      { sessionId: 'host', invocationId: 'expected' },
      context,
    ),
    { ok: true },
  );
  assert.deepEqual(cancelled, ['host']);
  assert.deepEqual(await Array.fromAsync(turn), [
    { type: 'done', outcome: 'cancelled' },
  ]);
});
