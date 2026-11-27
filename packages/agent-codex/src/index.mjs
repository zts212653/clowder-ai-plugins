const unsupported = { status: 'unsupported' };
const unavailable = { status: 'unavailable', reason: 'native_runtime_port_unavailable' };

function projectUsage(raw) {
  const tokenCounts = [
    ['inputTokens', raw?.input_tokens],
    ['outputTokens', raw?.output_tokens],
    ['cacheReadTokens', raw?.cached_input_tokens],
  ].filter(([, value]) => Number.isSafeInteger(value) && value >= 0);
  return Object.fromEntries(tokenCounts);
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
            label: 'Codex',
            capabilities: {
              resume: { status: 'supported', data: { mode: 'native' } },
              tools: { status: 'unknown', reason: 'host_launch_policy' },
              login: unsupported,
              input: unsupported,
              inspectInput: unsupported,
              compact: unsupported,
              modelCatalog: { status: 'unknown', reason: 'not_reported' },
              quota: { status: 'unknown', reason: 'not_reported' },
            },
          }),
          async detect(_input, context) {
            const state = await context?.nativeRuntime?.inspect?.(context.signal) ?? unavailable;
            return { candidates: [{ id: 'codex', label: 'Codex', state }] };
          },
          async openSession(input, context) {
            const runtime = context?.nativeRuntime;
            if (!runtime?.prepare) return { ok: false, code: 'failed', reason: unavailable.reason };
            if (!input.instructions.trim()) return { ok: false, code: 'failed', reason: 'Codex identity is empty' };
            const nativeSessionId = input.resume?.nativeSessionId;
            const prepared = await runtime.prepare({
              hostSessionId: input.sessionId,
              resumeNativeSessionId: nativeSessionId,
              instructions: input.instructions,
            }, context.signal);
            if (nativeSessionId && prepared.nativeSessionId !== nativeSessionId)
              return { ok: false, code: 'resume_unavailable', reason: 'Codex session identity unavailable' };
            sessions.set(input.sessionId, { nativeSessionId, model: input.model, instructions: input.instructions });
            const binding = nativeSessionId ? { state: 'bound', nativeSessionId } : { state: 'pending_first_input' };
            return { ok: true, binding };
          },
          async *startTurn(input, context) {
            const runtime = context?.nativeRuntime;
            const session = sessions.get(input.sessionId);
            if (!runtime?.run || !session || turns.has(input.sessionId)) throw new Error('Codex session unavailable');
            const controller = new AbortController();
            const signal = AbortSignal.any([context.signal, controller.signal]);
            turns.set(input.sessionId, { invocationId: input.invocationId, controller });
            let completed = false;
            let failed = false;
            let usage;
            const streamed = new Set();
            try {
              const args = session.nativeSessionId ? ['exec', 'resume', session.nativeSessionId] : ['exec'];
              args.push('--json', '-c', `developer_instructions=${JSON.stringify(session.instructions)}`);
              if (session.model) args.push('--model', session.model);
              args.push('--', '-');
              const stream = await runtime.run({ hostSessionId: input.sessionId, args, stdin: input.prompt }, signal);
              for await (const frame of stream) {
                if (frame.kind === 'exit') {
                  const outcome = signal.aborted ? 'cancelled' : frame.code === 0 && completed && !failed ? 'completed' : 'failed';
                  yield { type: 'done', outcome, ...(usage ? { messageUsage: usage } : {}) };
                  return;
                }
                if (signal.aborted) continue;
                const value = frame.value;
                if (value?.type === 'thread.started' && typeof value.thread_id === 'string' && value.thread_id) {
                  if (session.nativeSessionId && session.nativeSessionId !== value.thread_id)
                    throw new Error('Unexpected Codex native session');
                  if (!session.nativeSessionId) {
                    session.nativeSessionId = value.thread_id;
                    yield { type: 'native_bound', nativeSessionId: value.thread_id };
                  }
                } else if (value?.type === 'item.agent_message.delta' && typeof value.item_id === 'string' && typeof value.delta === 'string') {
                  streamed.add(value.item_id);
                  yield { type: 'output', text: value.delta };
                } else if (value?.type === 'item.completed' && value.item?.type === 'agent_message' && typeof value.item.text === 'string') {
                  if (!streamed.has(value.item.id)) yield { type: 'output', text: value.item.text };
                } else if (value?.type === 'turn.completed') {
                  usage = projectUsage(value.usage);
                  completed = true;
                } else if (value?.type === 'turn.failed') {
                  failed = true;
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
