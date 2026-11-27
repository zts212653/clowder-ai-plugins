import { basename, dirname } from 'node:path';
import {
  encodeAgyStreamJsonUserMessage,
  parseAgyStreamJsonLine,
  summarizeAgyStreamJsonTurn,
} from './agy-stream-json-parser.mjs';

const unsupported = { status: 'unsupported' };
const unavailable = {
  status: 'unavailable',
  reason: 'native_runtime_port_unavailable',
};
const nativeKey = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function create() {
  return {
    start() {
      const sessions = new Map();
      const turns = new Map();
      return {
        actions: {
          describe: () => ({
            protocolVersion: 1,
            label: 'Antigravity',
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
            const state =
              (await context?.nativeRuntime?.inspect?.(context.signal)) ??
              unavailable;
            return { candidates: [{ id: 'agy', label: 'Antigravity', state }] };
          },
          async openSession(input, context) {
            const runtime = context?.nativeRuntime;
            if (!runtime?.prepare)
              return { ok: false, code: 'failed', reason: unavailable.reason };
            if (!input.instructions.trim())
              return {
                ok: false,
                code: 'failed',
                reason: 'Antigravity identity is empty',
              };
            const nativeSessionId = input.resume?.nativeSessionId;
            if (nativeSessionId && !nativeKey.test(nativeSessionId)) {
              return {
                ok: false,
                code: 'resume_unavailable',
                reason: 'Invalid Antigravity conversation ID',
              };
            }
            const prepared = await runtime.prepare(
              {
                hostSessionId: input.sessionId,
                resumeNativeSessionId: nativeSessionId,
                instructions: input.instructions,
              },
              context.signal,
            );
            if (
              nativeSessionId &&
              prepared.nativeSessionId !== nativeSessionId
            ) {
              return {
                ok: false,
                code: 'resume_unavailable',
                reason: 'Antigravity conversation unavailable',
              };
            }
            const agentName =
              prepared.agentFile && basename(dirname(prepared.agentFile));
            if (
              !agentName ||
              !nativeKey.test(agentName) ||
              basename(prepared.agentFile) !== 'agent.md'
            ) {
              return {
                ok: false,
                code: 'failed',
                reason: 'Antigravity agent file is unavailable',
              };
            }
            sessions.set(input.sessionId, {
              nativeSessionId,
              agentName,
              model: input.model,
            });
            return {
              ok: true,
              binding: nativeSessionId
                ? { state: 'bound', nativeSessionId }
                : { state: 'pending_first_input' },
            };
          },
          async *startTurn(input, context) {
            const session = sessions.get(input.sessionId);
            const runtime = context?.nativeRuntime;
            if (!runtime?.run || !session || turns.has(input.sessionId))
              throw new Error('Antigravity session unavailable');
            const controller = new AbortController();
            const signal = AbortSignal.any([context.signal, controller.signal]);
            turns.set(input.sessionId, {
              invocationId: input.invocationId,
              controller,
            });
            const args = [
              '--agent',
              session.agentName,
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              '--print=',
            ];
            if (session.model) args.push('--model', session.model);
            if (session.nativeSessionId)
              args.push('--conversation', session.nativeSessionId);
            const events = [];
            try {
              const stream = await runtime.run(
                {
                  hostSessionId: input.sessionId,
                  args,
                  stdin: encodeAgyStreamJsonUserMessage(input.prompt) + '\n',
                },
                signal,
              );
              for await (const frame of stream) {
                if (frame.kind === 'exit') {
                  const turn = summarizeAgyStreamJsonTurn(events);
                  const success =
                    frame.code === 0 &&
                    turn.outcome === 'ok' &&
                    Boolean(session.nativeSessionId);
                  if (success && !signal.aborted)
                    yield { type: 'output', text: turn.finalText };
                  const usage = turn.turnUsage;
                  const messageUsage = usage && {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    totalTokens: usage.totalTokens,
                  };
                  yield {
                    type: 'done',
                    outcome: signal.aborted
                      ? 'cancelled'
                      : success
                        ? 'completed'
                        : 'failed',
                    ...(messageUsage ? { messageUsage } : {}),
                    ...(turn.outcome === 'denied'
                      ? { errorCode: 'native_permission_denied' }
                      : {}),
                  };
                  return;
                }
                if (signal.aborted) continue;
                const event = parseAgyStreamJsonLine(
                  JSON.stringify(frame.value),
                );
                if (!event) continue;
                if (event.conversationId) {
                  if (
                    !nativeKey.test(event.conversationId) ||
                    (session.nativeSessionId &&
                      session.nativeSessionId !== event.conversationId)
                  ) {
                    throw new Error('Unexpected Antigravity native session');
                  }
                  if (!session.nativeSessionId) {
                    session.nativeSessionId = event.conversationId;
                    yield {
                      type: 'native_bound',
                      nativeSessionId: event.conversationId,
                    };
                  }
                }
                events.push(event);
              }
            } finally {
              turns.delete(input.sessionId);
            }
          },
          cancel(input) {
            const turn = turns.get(input.sessionId);
            if (!turn || turn.invocationId !== input.invocationId)
              return { ok: false, code: 'turn_ended' };
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
