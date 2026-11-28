import { agyReplyEvidence } from './agy-reply-evidence.mjs';
import {
  AgyStepEvidence,
  isAgyAnonymousCompletion,
} from './agy-step-evidence.mjs';
import {
  parseAgyResultFields,
  parseAgyToolFields,
} from './agy-stream-json-fields.mjs';
const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}
function asString(value) {
  return typeof value === 'string' ? value : null;
}
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function parseUsage(value) {
  const record = asRecord(value);
  if (!record) return null;
  return {
    inputTokens: asNumber(record.input_tokens) ?? 0,
    outputTokens: asNumber(record.output_tokens) ?? 0,
    thinkingTokens: asNumber(record.thinking_tokens) ?? 0,
    cacheReadTokens: asNumber(record.cache_read_tokens) ?? 0,
    totalTokens: asNumber(record.total_tokens) ?? 0,
  };
}
function parseState(value) {
  return value === 'ACTIVE' || value === 'DONE' || value === 'ERROR'
    ? value
    : 'UNKNOWN';
}
export function encodeAgyStreamJsonUserMessage(text) {
  return JSON.stringify({
    event: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  });
}
function parseInitEvent(payload) {
  const init = asRecord(payload) ?? {};
  return {
    kind: 'init',
    cwd: asString(init.cwd) ?? '',
    tools: Array.isArray(init.tools)
      ? init.tools.filter((tool) => typeof tool === 'string')
      : [],
    permissionMode: asString(init.permission_mode) ?? '',
  };
}
function parseStepEvent(step) {
  const finishCompleted =
    step.step_type === 'finish' &&
    step.state === 'DONE' &&
    step.tool_name === undefined;
  return {
    kind: 'step',
    conversationId: asString(step.conversation_id) ?? '',
    stepIndex: asNumber(step.step_index) ?? -1,
    state: parseState(step.state),
    rawState: asString(step.state) ?? '',
    stepType: finishCompleted
      ? 'tool'
      : (asString(step.step_type) ?? 'unknown'),
    ...(isAgyAnonymousCompletion(step)
      ? {
          anonymousCompletion: true,
        }
      : {}),
    textDelta: asString(step.text_delta),
    toolName: finishCompleted ? 'finish' : asString(step.tool_name),
    ...parseAgyToolFields(step.tool_info),
    durationSeconds: asNumber(step.duration_seconds),
    usage: parseUsage(step.usage),
  };
}
function parseResultEvent(result) {
  return {
    kind: 'result',
    conversationId: asString(result.conversation_id) ?? '',
    status: asString(result.status) ?? 'UNKNOWN',
    response: asString(result.response) ?? '',
    hasResponse: typeof result.response === 'string',
    ...parseAgyResultFields(result),
    numTurns: asNumber(result.num_turns) ?? 0,
    usage: parseUsage(result.usage),
  };
}
export function parseAgyStreamJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const event = record ? asString(record.event) : null;
  if (!record || !event) return null;
  const unknown = {
    kind: 'unknown',
    event,
    raw: trimmed,
  };
  if (event === 'init') return parseInitEvent(record.init);
  if (event === 'step_update') {
    const step = asRecord(record.step_update);
    return step ? parseStepEvent(step) : unknown;
  }
  if (event === 'result') {
    const result = asRecord(record.result);
    return result ? parseResultEvent(result) : unknown;
  }
  return unknown;
}
function describeOutcome(
  outcome,
  deniedActions,
  toolCalls,
  resultError,
  anomalies = [],
) {
  switch (outcome) {
    case 'unconfirmed':
      return 'AGY reply completed with unidentified step completion evidence';
    case 'protocol_error':
      return `AGY protocol drift — result is not trustworthy: ${anomalies.map((anomaly) => anomaly.detail).join('; ')}`;
    case 'denied': {
      const names = deniedActions
        .map((action) => action.displayName)
        .join(', ');
      const reasons = toolCalls
        .map((call) => call.errorMessage)
        .filter((message) => Boolean(message));
      const detail = reasons.length > 0 ? ` — ${reasons[0]}` : '';
      return `AGY denied ${deniedActions.length} action(s) [${names}] with no human to approve them${detail}`;
    }
    case 'error':
      return resultError
        ? `AGY turn failed: ${resultError}`
        : 'AGY turn reported a non-success status';
    case 'empty':
      return 'AGY turn completed with no text output and no denial evidence';
    case 'incomplete':
      return 'AGY stream ended without a terminal result event';
    default:
      return 'AGY turn completed';
  }
}
function absorbStep(state, observed) {
  const event = state.evidence.observe(observed);
  state.anomalies.push(...event.anomalies);
  state.conversationId ??= event.conversationId || null;
  if (event.stepIndex >= 0) {
    if (state.firstStepIndex === null) state.firstStepIndex = event.stepIndex;
    state.lastStepIndex = event.stepIndex;
  }
  if (event.textDelta) state.deltas.push(event.textDelta);
  if (event.stepIndex >= 0) {
    const previous = state.steps.get(event.stepIndex);
    state.steps.set(event.stepIndex, {
      type: event.stepType,
      state: event.state,
      anonymousCompletion: event.anonymousCompletion === true,
      text:
        event.stepType === 'agent_response'
          ? (previous?.text ?? '') + (event.textDelta ?? '')
          : '',
    });
  }
  if (
    event.stepIndex >= 0 &&
    event.stepType === 'agent_response' &&
    event.usage
  ) {
    state.stepUsage.set(event.stepIndex, event.usage);
  }
  if (event.stepType !== 'tool' || !event.toolName) return;
  const previous = state.toolCalls.get(event.stepIndex);
  const hadPriorDone = previous
    ? previous.state === 'DONE'
      ? true
      : Boolean(previous.completedOnce)
    : false;
  state.toolCalls.set(event.stepIndex, {
    stepIndex: event.stepIndex,
    state: event.state,
    rawState: event.rawState,
    toolName: event.toolName,
    parameters: event.toolParameters ?? previous?.parameters ?? {},
    output: event.toolOutput ?? previous?.output ?? '',
    errorMessage: event.anomalies.length
      ? (previous?.errorMessage ?? event.toolErrorMessage ?? null)
      : (event.toolErrorMessage ?? previous?.errorMessage ?? null),
    durationSeconds: event.durationSeconds ?? previous?.durationSeconds ?? null,
    ...(hadPriorDone && event.state !== 'DONE'
      ? {
          completedOnce: true,
        }
      : {}),
  });
}
function decideOutcome(result, deniedActions, anomalies, finalText) {
  if (anomalies.length > 0) return 'protocol_error';
  if (!result) return 'incomplete';
  if (result.status !== 'SUCCESS' || result.error) return 'error';
  if (deniedActions.length > 0 && !finalText.trim()) return 'denied';
  return finalText.trim() === '' ? 'empty' : 'ok';
}
function accumulateTurn(events) {
  const state = {
    evidence: new AgyStepEvidence(),
    toolCalls: new Map(),
    stepUsage: new Map(),
    unknownEvents: [],
    anomalies: [],
    deltas: [],
    steps: new Map(),
    conversationId: null,
    firstStepIndex: null,
    lastStepIndex: null,
    result: null,
  };
  for (const event of events) {
    if (event.kind === 'result') state.anomalies.push(...event.anomalies);
    if (event.kind === 'unknown') {
      state.unknownEvents.push(event.event);
      state.anomalies.push({
        kind: 'unknown_event',
        detail: `unrecognized event ${event.event}`,
      });
    } else if (event.kind === 'result') {
      state.result = event;
      state.conversationId ??= event.conversationId || null;
    } else if (event.kind === 'step') absorbStep(state, event);
  }
  return state;
}
export function summarizeAgyStreamJsonTurn(events, terminalPolicyRejected) {
  const state = accumulateTurn(events);
  const {
    result,
    conversationId,
    firstStepIndex,
    lastStepIndex,
    unknownEvents,
  } = state;
  if (result && !result.hasResponse) {
    state.anomalies.push({
      kind: 'missing_result_response',
      detail: `terminal result for status ${JSON.stringify(result.status)} carried no "response" field`,
    });
  }
  const deniedActions = result?.deniedActions ?? [];
  const finalText = result?.hasResponse
    ? result.response
    : state.deltas.join('');
  const upstreamStatus = result?.status ?? null;
  const anomalies = state.anomalies;
  let outcome = decideOutcome(result, deniedActions, anomalies, finalText);
  const orderedToolCalls = [...state.toolCalls.values()].sort(
    (a, b) => a.stepIndex - b.stepIndex,
  );
  const usageSteps = [...state.stepUsage.entries()].sort(([a], [b]) => a - b);
  const turnUsage = usageSteps.length
    ? usageSteps.reduce(
        (sum, [, usage]) => ({
          inputTokens: sum.inputTokens + usage.inputTokens,
          outputTokens: sum.outputTokens + usage.outputTokens,
          thinkingTokens: sum.thinkingTokens + usage.thinkingTokens,
          cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
          totalTokens: sum.totalTokens + usage.totalTokens,
        }),
        EMPTY_USAGE,
      )
    : null;
  const latestUsage = usageSteps.at(-1)?.[1];
  const steps = [...state.steps.entries()];
  const unconfirmedStepIndices = steps
    .filter(([, step]) => step.anonymousCompletion)
    .map(([index]) => index);
  const {
    completedResponseStep,
    completedCompactionStep,
    recoveredErrorSteps,
    anonymousReplyComplete,
    retainedAttemptEOF,
  } = agyReplyEvidence({
    steps: state.steps,
    lastStepIndex,
    finalText,
    deltaText: state.deltas.join(''),
    upstreamStatus,
    upstreamError: result?.error ?? null,
    terminalPolicyRejected:
      typeof terminalPolicyRejected === 'function'
        ? terminalPolicyRejected(result?.error ?? '')
        : terminalPolicyRejected,
    hasDeniedActions: deniedActions.length > 0,
  });
  if (
    (outcome === 'ok' ||
      (outcome === 'error' && retainedAttemptEOF && anonymousReplyComplete)) &&
    unconfirmedStepIndices.length > 0
  ) {
    outcome = anonymousReplyComplete ? 'unconfirmed' : 'protocol_error';
    if (!anonymousReplyComplete)
      anomalies.push({
        kind: 'invalid_step_identity',
        detail: 'anonymous completion has no matching complete current reply',
      });
  }
  return {
    conversationId,
    firstStepIndex,
    lastStepIndex,
    finalText,
    toolCalls: orderedToolCalls,
    stepsComplete:
      anomalies.length === 0 &&
      unconfirmedStepIndices.length === 0 &&
      steps.every(([, step]) => step.state === 'DONE'),
    unconfirmedStepIndices,
    deniedActions,
    usage: result?.usage ?? EMPTY_USAGE,
    turnUsage,
    lastTurnInputTokens: latestUsage
      ? latestUsage.inputTokens + latestUsage.cacheReadTokens
      : null,
    upstreamStatus,
    upstreamError: result?.error ?? null,
    sessionTurnCount: result?.numTurns ?? 0,
    completedResponseStep,
    completedCompactionStep,
    recoveredErrorSteps,
    outcome,
    diagnosis: describeOutcome(
      outcome,
      deniedActions,
      orderedToolCalls,
      result?.error ?? null,
      anomalies,
    ),
    unknownEvents,
    anomalies,
  };
}
