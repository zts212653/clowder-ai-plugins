import { normalizeKimiEvent } from './kimi-events.mjs';
import { buildKimiLaunchArguments } from './kimi-launch.mjs';
import { parseKimiCliUsageOutput } from './kimi-quota.mjs';

const unavailable = { status: 'unsupported' };
const portMissing = { status: 'unavailable', reason: 'native_runtime_port_unavailable' };

function describe() {
  return {
    protocolVersion: 1,
    label: 'Kimi Code',
    capabilities: {
      resume: { status: 'supported', data: { mode: 'native' } },
      tools: { status: 'supported', data: { approval: 'client' } },
      login: unavailable,
      input: unavailable,
      inspectInput: unavailable,
      compact: unavailable,
      modelCatalog: { status: 'unknown', reason: 'not_reported' },
      quota: { status: 'supported', data: { source: 'native-command', units: ['ratio'] } },
    },
  };
}

// nativeRuntime is a Host grant for this call. No executable path, account
// environment or other role's session comes from the worker's input DTO.
function create() {
  return {
    start() {
      const sessions = new Map();
      const turns = new Map();
      return {
        actions: {
          describe,
          async detect(_input, context) {
            const state = await context?.nativeRuntime?.inspect?.(context.signal) ?? portMissing;
            return { candidates: [{ id: 'kimi', label: 'Kimi Code', state }] };
          },
          async openSession(input, context) {
            const runtime = context?.nativeRuntime;
            if (!runtime?.prepare) return { ok: false, code: 'failed', reason: portMissing.reason };
            const prepared = await runtime.prepare({
              hostSessionId: input.sessionId,
              resumeNativeSessionId: input.resume?.nativeSessionId,
              instructions: input.instructions,
            }, context.signal);
            const resume = input.resume?.nativeSessionId;
            if (resume && prepared.nativeSessionId !== resume) {
              return { ok: false, code: 'resume_unavailable', reason: 'Kimi session identity unavailable' };
            }
            sessions.set(input.sessionId, {
              nativeSessionId: resume,
              agentFile: prepared.agentFile,
              model: input.model,
            });
            const binding = resume
              ? { state: 'bound', nativeSessionId: resume }
              : { state: 'pending_first_input' };
            return { ok: true, binding };
          },
          async *startTurn(input, context) {
            const runtime = context?.nativeRuntime;
            const session = sessions.get(input.sessionId);
            if (!runtime?.run || !session || turns.has(input.sessionId)) throw new Error('Kimi session unavailable');
            const controller = new AbortController();
            const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
            turns.set(input.sessionId, { invocationId: input.invocationId, controller });
            let messageUsage;
            let replySeen = false;
            let toolIndex = 0;
            try {
              const { args } = buildKimiLaunchArguments({
                prompt: input.prompt,
                imageAccessDirs: [],
                model: session.model,
                resumeSessionId: session.nativeSessionId,
                agentFile: session.nativeSessionId ? undefined : session.agentFile,
              });
              const stream = await runtime.run({ hostSessionId: input.sessionId, args }, signal);
              for await (const frame of stream) {
                if (frame.kind === 'exit') {
                  const outcome = signal.aborted ? 'cancelled' : frame.code === 0 && replySeen ? 'completed' : 'failed';
                  yield { type: 'done', outcome, ...(messageUsage ? { messageUsage } : {}) };
                  return;
                }
                if (signal.aborted) continue;
                const event = normalizeKimiEvent(frame.value);
                if (event.kind === 'ignored') continue;
                const observed = event.sessionId;
                if (observed && session.nativeSessionId && observed !== session.nativeSessionId) {
                  throw new Error('Unexpected Kimi native session');
                }
                if (observed && !session.nativeSessionId) {
                  session.nativeSessionId = observed;
                  yield { type: 'native_bound', nativeSessionId: observed };
                }
                if (event.kind !== 'assistant') continue;
                if (event.text) {
                  replySeen = true;
                  yield { type: 'output', text: event.text };
                }
                for (const tool of event.tools) {
                  toolIndex += 1;
                  yield { type: 'tool_call', callId: `tool-${toolIndex}`, name: tool.name, input: tool.input };
                }
                messageUsage = event.usage ?? messageUsage;
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
          async quota(_input, context) {
            const terminal = context?.nativeRuntime?.terminal;
            if (!terminal) throw new Error(portMissing.reason);
            const { output, observedAt } = await terminal.capture({ submit: '/usage' }, context.signal);
            const items = parseKimiCliUsageOutput(output, observedAt);
            if (items.length === 0) throw new Error('Kimi quota observation unavailable');
            return {
              source: 'native-command',
              observedAt,
              windows: items.map((item) => ({
                id: item.poolId,
                label: item.label,
                unit: 'ratio',
                used: (item.percentKind === 'remaining' ? 100 - item.usedPercent : item.usedPercent) / 100,
                ...(item.resetsAt ? { resetsAt: item.resetsAt } : {}),
              })),
            };
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
