const STEP_TYPES = new Set([
  'user_input',
  'system_message',
  'agent_response',
  'tool',
  'checkpoint',
  'error_message',
]);
export function isAgyAnonymousCompletion(step) {
  return (
    step.step_type === 'unknown' &&
    step.state === 'DONE' &&
    Number.isSafeInteger(step.step_index) &&
    typeof step.step_index === 'number' &&
    step.step_index >= 0 &&
    typeof step.conversation_id === 'string' &&
    step.conversation_id.trim().length > 0 &&
    typeof step.duration_seconds === 'number' &&
    Number.isFinite(step.duration_seconds) &&
    step.duration_seconds >= 0 &&
    Object.keys(step).every((key) =>
      [
        'conversation_id',
        'step_index',
        'step_type',
        'state',
        'duration_seconds',
      ].includes(key),
    )
  );
}
function resolveAgyStepCompletion(
  event,
  previousType,
  previousToolName,
  previousConversationId,
) {
  if (
    !event.anonymousCompletion ||
    previousType !== 'tool' ||
    previousToolName !== 'wait' ||
    previousConversationId !== event.conversationId
  )
    return event;
  return {
    ...event,
    stepType: 'tool',
    toolName: 'wait',
    anonymousCompletion: undefined,
  };
}
export function agyStepEvidenceAnomalies(
  event,
  previousType,
  previousToolName,
) {
  const anomalies = [];
  const invalid = (kind, detail) => {
    anomalies.push({
      kind,
      detail: `step ${event.stepIndex}: ${detail}`,
    });
  };
  if (!Number.isSafeInteger(event.stepIndex) || event.stepIndex < 0) {
    invalid('invalid_step_identity', 'missing or invalid index');
  }
  if (!event.conversationId.trim())
    invalid('invalid_step_identity', 'missing conversation ID');
  if (
    !STEP_TYPES.has(event.stepType) &&
    !(event.stepType === 'unknown' && event.anonymousCompletion)
  )
    invalid(
      'unknown_step_type',
      `unrecognized type ${JSON.stringify(event.stepType)}`,
    );
  if (event.stepType === 'tool' && !event.toolName?.trim())
    invalid('invalid_tool_identity', 'missing tool name');
  if (previousType !== undefined && previousType !== event.stepType) {
    invalid('invalid_step_identity', 'type changed during an existing step');
  }
  if (previousToolName !== undefined && previousToolName !== event.toolName) {
    invalid(
      'invalid_tool_identity',
      'tool name changed during an existing step',
    );
  }
  return anomalies;
}
export class AgyStepEvidence {
  first = new Map();
  invalid = new Set();
  observe(observed) {
    const previous = this.first.get(observed.stepIndex);
    const event = resolveAgyStepCompletion(
      observed,
      previous?.type,
      previous?.toolName ?? undefined,
      previous?.conversationId,
    );
    const anomalies = [
      ...(event.anomalies ?? []),
      ...agyStepEvidenceAnomalies(
        event,
        previous?.type,
        previous?.toolName ?? undefined,
      ),
    ];
    if (event.state === 'UNKNOWN')
      anomalies.push({
        kind: 'unknown_step_state',
        detail: `step ${event.stepIndex} reported unrecognized state ${JSON.stringify(event.rawState)}`,
      });
    if (previous && previous.conversationId !== event.conversationId)
      anomalies.push({
        kind: 'invalid_step_identity',
        detail: `step ${event.stepIndex}: conversation ID changed`,
      });
    if (anomalies.length) this.invalid.add(event.stepIndex);
    else if (this.invalid.has(event.stepIndex))
      anomalies.push({
        kind: 'invalid_step_identity',
        detail: `step ${event.stepIndex}: earlier invalid evidence remains unresolved`,
      });
    if (!previous)
      this.first.set(event.stepIndex, {
        type: event.stepType,
        toolName: event.toolName,
        conversationId: event.conversationId,
      });
    return {
      ...event,
      anomalies,
      ...(anomalies.length &&
      event.stepType === 'tool' &&
      !event.toolErrorMessage
        ? {
            toolErrorMessage: `Native tool result unconfirmed: ${anomalies.map((a) => a.detail).join('; ')}`,
          }
        : {}),
    };
  }
}
