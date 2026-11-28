import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.mjs';

const contextFor = (nativeRuntime) => ({ nativeRuntime, signal: new AbortController().signal });
const fixture = () => worker.create().start();
const record = (value) => ({ kind: 'record', value });
const exit = (code) => ({ kind: 'exit', code });
const identityFingerprint = createHash('sha256').update('identity').digest('hex').slice(0, 16);

test('reports missing Host grant and refuses unverified native resume', async () => {
  const { actions } = fixture();
  const [candidate] = (await actions.detect({})).candidates;
  assert.equal(candidate.state.status, 'unavailable');
  const input = { sessionId: 'host-1', instructions: 'identity', resume: { nativeSessionId: 'previous' } };
  const missing = await actions.openSession(input);
  assert.deepEqual(missing, { ok: false, code: 'failed', reason: 'native_runtime_port_unavailable' });
  const result = await actions.openSession(input, contextFor({
    prepare: async () => ({ nativeSessionId: 'different' }),
  }));
  assert.equal(result.code, 'resume_unavailable');
});

test('rejects an absent new agent file and resumes only the current verified identity', async () => {
  const { actions } = fixture();
  const input = { sessionId: 'host-1', instructions: 'identity' };
  const missing = await actions.openSession(input, contextFor({ prepare: async () => ({}) }));
  assert.equal(missing.ok, false);
  const resumeInput = { ...input, resume: { nativeSessionId: 'old' } };
  for (const [stored, identityStatus] of [[undefined, 'unverifiable'], ['another', 'stale']]) {
    const result = await actions.openSession(resumeInput, contextFor({
      prepare: async () => ({ nativeSessionId: 'old', sessionFingerprint: stored }),
    }));
    assert.equal(result.code, 'resume_unavailable');
    assert.equal(result.identityStatus, identityStatus);
  }
  const matched = await actions.openSession(resumeInput, contextFor({
    prepare: async () => ({ nativeSessionId: 'old', sessionFingerprint: identityFingerprint }),
  }));
  assert.deepEqual(matched, { ok: true, binding: { state: 'bound', nativeSessionId: 'old' } });
});

test('launches a new session with its agent file then resumes the bound native ID', async () => {
  const { actions } = fixture();
  const launches = [];
  const bindings = [];
  const ctx = contextFor({
    inspect: async () => ({ status: 'ready', version: '0.38.0' }),
    prepare: async (request) => {
      assert.equal(request.instructions, 'identity');
      return { agentFile: 'host-managed-instructions.md' };
    },
    async recordSessionFingerprint(request) {
      bindings.push(request);
    },
    async *run(plan) {
      launches.push(plan);
      yield record({ role: 'assistant', content: 'fixture text', session_id: 'native-1',
        usage: { input_tokens: 8, output_tokens: 3 } });
      yield exit(0);
    },
  });
  assert.equal((await actions.detect({}, ctx)).candidates[0].state.version, '0.38.0');
  const opened = await actions.openSession({ sessionId: 'host-1', instructions: 'identity' }, ctx);
  assert.deepEqual(opened.binding, { state: 'pending_first_input' });
  const input = { sessionId: 'host-1', invocationId: 'turn-1', prompt: 'hello' };
  const first = await Array.fromAsync(actions.startTurn(input, ctx));
  assert.deepEqual(first, [
    { type: 'native_bound', nativeSessionId: 'native-1' },
    { type: 'output', text: 'fixture text' },
    { type: 'done', outcome: 'completed', messageUsage: { inputTokens: 8, outputTokens: 3 } },
  ]);
  await Array.fromAsync(actions.startTurn({ ...input, invocationId: 'turn-2' }, ctx));
  assert.deepEqual(launches[0].args, ['--output-format', 'stream-json', '--agent-file', 'host-managed-instructions.md', '-p', 'hello']);
  assert.deepEqual(launches[1].args, ['--output-format', 'stream-json', '--session', 'native-1', '-p', 'hello']);
  assert.deepEqual(bindings, [{ hostSessionId: 'host-1', nativeSessionId: 'native-1', fingerprint: identityFingerprint }]);
  assert.deepEqual(await actions.release({ sessionId: 'host-1' }), { ok: true });
  await assert.rejects(Array.fromAsync(actions.startTurn(input, ctx)), /session unavailable/);
});

test('cancels the expected turn and drains its exit outcome', async () => {
  const { actions } = fixture();
  const ctx = contextFor({
    prepare: async () => ({ nativeSessionId: 'prior', sessionFingerprint: identityFingerprint }),
    async *run(_plan, signal) {
      yield record({ role: 'assistant', content: 'before cancellation', session_id: 'prior' });
      assert.equal(signal.aborted, true);
      yield record({ role: 'assistant', content: 'late text', session_id: 'prior' });
      yield exit(0);
    },
  });
  const input = { sessionId: 'host-1', invocationId: 'active', prompt: 'hello' };
  await actions.openSession({ sessionId: 'host-1', instructions: 'identity', resume: { nativeSessionId: 'prior' } }, ctx);
  const turn = actions.startTurn(input, ctx);
  assert.equal((await turn.next()).value.text, 'before cancellation');
  assert.equal(actions.cancel({ ...input, invocationId: 'stale' }).code, 'turn_ended');
  assert.deepEqual(actions.cancel(input), { ok: true });
  assert.deepEqual((await turn.next()).value, { type: 'done', outcome: 'cancelled' });
  await turn.return();
});

test('reads quota from the scoped terminal and normalizes percentage direction', async () => {
  const observedAt = Date.parse('2026-11-27T00:00:00Z');
  const captures = [];
  const ctx = contextFor({
    terminal: {
      capture: async (request) => {
        captures.push(request);
        return { observedAt, output: '5h limit 25% used\r\nweekly limit 90% left' };
      },
    },
  });
  const { actions } = fixture();
  const result = await actions.quota({}, ctx);
  assert.deepEqual(captures, [{ submit: '/usage' }]);
  assert.equal(result.source, 'native-command');
  assert.equal(result.observedAt, observedAt);
  assert.deepEqual(result.windows.map(({ id, used }) => [id, used]), [
    ['kimi-rate-limit', 0.25], ['kimi-weekly', 0.1],
  ]);
});
