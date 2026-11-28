const unsupported = { status: 'unsupported' };
const unavailable = { status: 'unavailable', reason: 'native_runtime_port_unavailable' };
const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function readUsage(raw) {
  const counts = Object.fromEntries(
    [
      ['inputTokens', raw?.input_tokens],
      ['outputTokens', raw?.output_tokens],
      ['cacheReadTokens', raw?.cache_read_input_tokens],
      ['cacheCreationTokens', raw?.cache_creation_input_tokens],
    ].filter(([, value]) => Number.isSafeInteger(value) && value >= 0),
  );
  return Object.keys(counts).length ? counts : undefined;
}

function create() {
  return {
    start() {
      const sessions = new Map();
      const turns = new Map();
      return {
        actions: {
          describe: () => ({
            protocolVersion: 1,
            label: 'Claude Code',
            capabilities: {
              resume: { status: 'supported', data: { mode: 'native' } },
              tools: unsupported,
              login: unsupported,
              input: unsupported,
              inspectInput: unsupported,
              compact: unsupported,
              modelCatalog: { status: 'unknown', reason: 'not_reported' },
              quota: { status: 'unknown', reason: 'not_reported' },
            },
          }),
          async detect(_input, context) {
            const state = (await context?.nativeRuntime?.inspect?.(context.signal)) ?? unavailable;
            return { candidates: [{ id: 'claude-code', label: 'Claude Code', state }] };
          },
          async openSession(input, context) {
            const runtime = context?.nativeRuntime;
            if (!runtime?.prepare) return { ok: false, code: 'failed', reason: unavailable.reason };
            if (!input.instructions.trim()) {
              return { ok: false, code: 'failed', reason: 'Claude Code identity is empty' };
            }
            const nativeSessionId = input.resume?.nativeSessionId;
            if (nativeSessionId && !sessionIdPattern.test(nativeSessionId)) {
              return { ok: false, code: 'resume_unavailable', reason: 'Invalid Claude Code session ID' };
            }
            const prepared = await runtime.prepare(
              {
                hostSessionId: input.sessionId,
                resumeNativeSessionId: nativeSessionId,
                instructions: input.instructions,
              },
              context.signal,
            );
            if (nativeSessionId && prepared.nativeSessionId !== nativeSessionId) {
              return { ok: false, code: 'resume_unavailable', reason: 'Claude Code session identity unavailable' };
            }
            if (!prepared.agentFile) {
              return { ok: false, code: 'failed', reason: 'Claude Code identity file is unavailable' };
            }
            sessions.set(input.sessionId, { nativeSessionId, model: input.model, agentFile: prepared.agentFile });
            return {
              ok: true,
              binding: nativeSessionId ? { state: 'bound', nativeSessionId } : { state: 'pending_first_input' },
            };
          },
          async *startTurn(input, context) {
            const session = sessions.get(input.sessionId);
            const runtime = context?.nativeRuntime;
            if (!runtime?.run || !session || turns.has(input.sessionId)) {
              throw new Error('Claude Code session unavailable');
            }
            const controller = new AbortController();
            const signal = AbortSignal.any([context.signal, controller.signal]);
            turns.set(input.sessionId, { invocationId: input.invocationId, controller });
            const args = [
              '--print', '--verbose', '--output-format', 'stream-json',
              '--system-prompt-file', session.agentFile,
              '--tools', '', '--strict-mcp-config', '--setting-sources', '',
            ];
            if (session.nativeSessionId) args.push('--resume', session.nativeSessionId);
            if (session.model) args.push('--model', session.model);
            let initialized = false;
            let terminal;
            try {
              const stream = await runtime.run({ hostSessionId: input.sessionId, args, stdin: input.prompt }, signal);
              for await (const frame of stream) {
                if (frame.kind === 'exit') {
                  const success = frame.code === 0 && initialized && terminal?.subtype === 'success' && !terminal.is_error;
                  const usage = readUsage(terminal?.usage);
                  yield {
                    type: 'done',
                    outcome: signal.aborted ? 'cancelled' : success ? 'completed' : 'failed',
                    ...(usage ? { messageUsage: usage } : {}),
                  };
                  return;
                }
                if (signal.aborted) continue;
                const value = frame.value;
                if (value?.type === 'system' && value.subtype === 'init') {
                  if (typeof value.session_id !== 'string' || !sessionIdPattern.test(value.session_id) ||
                      (session.nativeSessionId && session.nativeSessionId !== value.session_id)) {
                    throw new Error('Unexpected Claude Code native session');
                  }
                  if (!session.nativeSessionId) {
                    session.nativeSessionId = value.session_id;
                    yield { type: 'native_bound', nativeSessionId: value.session_id };
                  }
                  initialized = true;
                  continue;
                }
                if (!initialized) continue;
                if (value?.session_id && value.session_id !== session.nativeSessionId) {
                  throw new Error('Unexpected Claude Code native session');
                }
                if (value?.type === 'assistant' && Array.isArray(value.message?.content)) {
                  for (const block of value.message.content) {
                    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
                      yield { type: 'output', text: block.text };
                    }
                  }
                } else if (value?.type === 'result') {
                  terminal = value;
                }
              }
            } finally {
              turns.delete(input.sessionId);
            }
          },
          cancel(input) {
            const turn = turns.get(input.sessionId);
            if (!turn || turn.invocationId !== input.invocationId) return { ok: false, code: 'turn_ended' };
            turn.controller.abort();
            return { ok: true };
          },
          release(input) {
            turns.get(input.sessionId)?.controller.abort();
            sessions.delete(input.sessionId);
            return { ok: true };
          },
        },
        stop() {
          for (const turn of turns.values()) turn.controller.abort();
          turns.clear();
          sessions.clear();
        },
      };
    },
  };
}

export default { create };
