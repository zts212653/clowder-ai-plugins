import { createHash } from 'node:crypto';

const unavailable = {
  status: 'unavailable',
  reason: 'native_acp_runtime_unavailable',
};
const unsupported = { status: 'unsupported' };

function create() {
  return {
    start() {
      const sessions = new Map();
      const turns = new Map();
      return {
        actions: {
          describe: () => ({
            protocolVersion: 1,
            label: 'DeepSeek Harness',
            capabilities: {
              resume: { status: 'supported', data: { mode: 'native' } },
              tools: unsupported,
              login: unsupported,
              input: unsupported,
              inspectInput: unsupported,
              compact: unsupported,
              modelCatalog: { status: 'unknown', reason: 'not_reported' },
              quota: unsupported,
            },
          }),
          async detect(_input, context) {
            const state =
              (await context?.nativeRuntime?.inspect?.(context.signal)) ??
              unavailable;
            return {
              candidates: [{ id: 'dsh', label: 'DeepSeek Harness', state }],
            };
          },
          async openSession(input, context) {
            const acp = context?.nativeRuntime?.acp;
            if (!acp)
              return { ok: false, code: 'failed', reason: unavailable.reason };
            const body = input.instructions;
            if (!body.trim())
              return {
                ok: false,
                code: 'failed',
                reason: 'DeepSeek Harness identity is empty',
              };
            const resumeNativeSessionId = input.resume?.nativeSessionId;
            const marker =
              '<!-- clowder-l0:' +
              createHash('sha256').update(body).digest('hex') +
              ' -->';
            const result = await acp.open(
              {
                hostSessionId: input.sessionId,
                resumeNativeSessionId,
                startup: {
                  moduleUrl: new URL('./dsh-l0-series.mjs', import.meta.url)
                    .href,
                  config: { marker, body },
                },
              },
              context.signal,
            );
            if (!result.ok)
              return {
                ok: false,
                code: result.code,
                reason: 'DeepSeek Harness could not open the native session',
              };
            if (
              resumeNativeSessionId &&
              result.nativeSessionId !== resumeNativeSessionId
            ) {
              await acp.release(input.sessionId);
              return {
                ok: false,
                code: 'resume_unavailable',
                reason: 'DeepSeek Harness returned a different native session',
              };
            }
            sessions.set(input.sessionId, result.nativeSessionId);
            return {
              ok: true,
              binding: {
                state: 'bound',
                nativeSessionId: result.nativeSessionId,
              },
            };
          },
          async *startTurn(input, context) {
            const acp = context?.nativeRuntime?.acp;
            const nativeId = sessions.get(input.sessionId);
            if (!acp || !nativeId || turns.has(input.sessionId))
              throw new Error('DeepSeek Harness session unavailable');
            const controller = new AbortController();
            const signal = AbortSignal.any([context.signal, controller.signal]);
            turns.set(input.sessionId, {
              invocationId: input.invocationId,
              controller,
            });
            let hasOutput = false;
            let messageUsage;
            try {
              const stream = await acp.prompt(
                { hostSessionId: input.sessionId, prompt: input.prompt },
                signal,
              );
              for await (const frame of stream) {
                if (frame.kind === 'terminal') {
                  const completed =
                    frame.finalResponse &&
                    frame.stopReason === 'end_turn' &&
                    hasOutput;
                  yield {
                    type: 'done',
                    outcome:
                      signal.aborted || frame.stopReason === 'cancelled'
                        ? 'cancelled'
                        : completed
                          ? 'completed'
                          : 'failed',
                    ...(messageUsage ? { messageUsage } : {}),
                  };
                  return;
                }
                if (frame.update.sessionId !== nativeId)
                  throw new Error('Unexpected DeepSeek Harness native session');
                const { sessionUpdate, content, used, size } =
                  frame.update.update;
                if (sessionUpdate === 'usage_update') {
                  messageUsage = {
                    ...(Number.isSafeInteger(used) && used >= 0
                      ? { contextUsedTokens: used, lastTurnInputTokens: used }
                      : {}),
                    ...(Number.isSafeInteger(size) && size > 0
                      ? { contextWindowSize: size }
                      : {}),
                  };
                }
                if (
                  !signal.aborted &&
                  sessionUpdate === 'agent_message_chunk' &&
                  content?.type === 'text' &&
                  content.text
                ) {
                  hasOutput = true;
                  yield { type: 'output', text: content.text };
                }
              }
              yield {
                type: 'done',
                outcome: signal.aborted ? 'cancelled' : 'failed',
              };
            } catch (error) {
              if (!signal.aborted) throw error;
              yield { type: 'done', outcome: 'cancelled' };
            } finally {
              turns.delete(input.sessionId);
            }
          },
          async cancel(input, context) {
            const turn = turns.get(input.sessionId);
            const acp = context?.nativeRuntime?.acp;
            if (!turn || !acp || turn.invocationId !== input.invocationId)
              return { ok: false, code: 'turn_ended' };
            if (!(await acp.cancel(input.sessionId)))
              return { ok: false, code: 'turn_ended' };
            turn.controller.abort();
            return { ok: true };
          },
          async release(input, context) {
            turns.get(input.sessionId)?.controller.abort();
            sessions.delete(input.sessionId);
            await context?.nativeRuntime?.acp?.release(input.sessionId);
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
