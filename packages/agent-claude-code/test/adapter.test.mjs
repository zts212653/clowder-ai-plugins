import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import plugin from '../src/index.mjs';

const executable = process.env.CLOWDER_CLAUDE_CANDIDATE_EXECUTABLE;
const nativeId = 'd430167d-c10d-4364-9fce-1466017536e7';

test('Claude Code requires a scoped identity file, native binding and successful result', async () => {
  const { actions } = plugin.create().start();
  const session = { sessionId: 'fixture', instructions: 'fixture role' };
  const context = {
    signal: new AbortController().signal,
    nativeRuntime: { prepare: async () => ({}) },
  };
  assert.equal((await actions.openSession(session, context)).code, 'failed');
  context.nativeRuntime.prepare = async () => ({ agentFile: 'private-file' });
  assert.equal((await actions.openSession({ ...session, resume: { nativeSessionId: nativeId } }, context)).code, 'resume_unavailable');
  assert.equal((await actions.openSession(session, context)).ok, true);
  context.nativeRuntime.run = async function* ({ args, stdin }) {
    assert.ok(args.includes('--system-prompt-file'));
    assert.equal(stdin, 'fixture prompt');
    yield { kind: 'record', value: { type: 'system', subtype: 'init', session_id: nativeId } };
    yield { kind: 'exit', code: 0 };
  };
  assert.deepEqual(
    await Array.fromAsync(actions.startTurn({ sessionId: session.sessionId, invocationId: 'one', prompt: 'fixture prompt' }, context)),
    [{ type: 'native_bound', nativeSessionId: nativeId }, { type: 'done', outcome: 'failed' }],
  );
});

test('actual Claude Code prints and resumes with its original ID, history and system identity', {
  skip: !executable,
  timeout: 60_000,
}, async (t) => {
  const parent = resolve(tmpdir());
  const home = await mkdtemp(join(parent, 'claude-adapter-loopback-'));
  t.after(async () => {
    assert.equal(dirname(home), parent);
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  });
  const handled = [];
  const server = createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    if (request.url?.endsWith('/count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    if (!request.url?.includes('/v1/messages')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    handled.push(body);
    const text = 'loopback-claude-reply-' + handled.length;
    const usage = { input_tokens: 12, output_tokens: 4 };
    const message = {
      id: 'msg_fixture_' + handled.length,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
      { type: 'message_stop' },
    ]) {
      response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    }
    response.end();
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const agentFile = join(home, 'identity.txt');
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: home,
    TMP: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: 'test-only-not-a-provider-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    NO_PROXY: '127.0.0.1',
  };
  const { actions } = plugin.create().start();
  const context = {
    signal: AbortSignal.timeout(50_000),
    nativeRuntime: {
      async prepare(input) {
        await writeFile(agentFile, input.instructions);
        return { nativeSessionId: input.resumeNativeSessionId, agentFile };
      },
      async *run({ args, stdin }, signal) {
        const child = spawn(executable, args, {
          cwd: home, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
        });
        const exited = once(child, 'close');
        child.stdin.end(stdin);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        for await (const line of createInterface({ input: child.stdout })) {
          yield { kind: 'record', value: JSON.parse(line) };
        }
        const [code] = await exited;
        if (code !== 0) t.diagnostic(stderr.slice(0, 1000));
        yield { kind: 'exit', code };
      },
    },
  };
  const role = { instructions: 'CLAUDE_IDENTITY_FIXTURE', model: 'claude-sonnet-4-6' };
  assert.equal((await actions.openSession({ ...role, sessionId: 'fresh' }, context)).ok, true);
  const first = await Array.fromAsync(
    actions.startTurn({ sessionId: 'fresh', invocationId: 'first', prompt: 'CLAUDE_FIRST_FIXTURE' }, context),
  );
  assert.equal(first.at(-1)?.outcome, 'completed', JSON.stringify(first));
  assert.match(first[0].nativeSessionId, /^[0-9a-f-]{36}$/i);
  assert.ok(first.some(({ text }) => text === 'loopback-claude-reply-1'));
  assert.equal(first.at(-1).messageUsage?.outputTokens, 4);
  const { nativeSessionId } = first[0];
  actions.release({ sessionId: 'fresh' });
  assert.deepEqual(
    await actions.openSession({ ...role, sessionId: 'resumed', resume: { nativeSessionId } }, context),
    { ok: true, binding: { state: 'bound', nativeSessionId } },
  );
  const resumed = await Array.fromAsync(
    actions.startTurn({ sessionId: 'resumed', invocationId: 'second', prompt: 'CLAUDE_SECOND_FIXTURE' }, context),
  );
  assert.equal(resumed.at(-1)?.outcome, 'completed', JSON.stringify(resumed));
  assert.ok(resumed.some(({ text }) => text === 'loopback-claude-reply-2'));
  assert.equal(handled.length, 2);
  assert.match(JSON.stringify(handled[1].system), /CLAUDE_IDENTITY_FIXTURE/);
  assert.doesNotMatch(JSON.stringify(handled[1].messages), /CLAUDE_IDENTITY_FIXTURE/);
  assert.match(JSON.stringify(handled[1].messages), /CLAUDE_FIRST_FIXTURE/);
  assert.match(JSON.stringify(handled[1].messages), /loopback-claude-reply-1/);
  assert.match(JSON.stringify(handled[1].messages), /CLAUDE_SECOND_FIXTURE/);
});
