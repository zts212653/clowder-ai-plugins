const priority = { reasoning: 1, tool: 2, workspace_fetch: 3, workspace_dispatch: 4, screen_read: 5 };
const semantic = {
  reasoning: 'reasoning',
  tool: 'tool',
  workspace_fetch: 'workspace',
  workspace_dispatch: 'workspace',
  screen_read: 'screen_reading',
};

/** Normalize the Host's bounded call snapshot; never infer work from chat text. */
export function normalizeNativeWork(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.active) || !Array.isArray(value.recent)) return null;
  const active = value.active
    .filter(entry => entry && semantic[entry.kind] && Number.isFinite(entry.expiresAt) && entry.expiresAt > now)
    .sort((left, right) => priority[right.kind] - priority[left.kind] || right.startedAt - left.startedAt)[0];
  const handed = [...value.recent].reverse().find(event => event?.kind === 'result'
    && event.phase === 'result_handed_to_voice' && typeof event.resultId === 'string'
    && event.resultId.length > 0 && Number.isFinite(event.expiresAt) && event.expiresAt > now);
  return {
    work: active ? { taskId: active.taskId, kind: semantic[active.kind], status: 'active', expiresAt: active.expiresAt } : null,
    delivery: handed ? { resultId: handed.resultId, status: 'applied', expiresAt: handed.expiresAt } : null,
    travel: null,
  };
}

const workLabels = {
  reasoning: '正在思考',
  tool: '正在处理',
  workspace: '正在处理家里的事务',
  screen_reading: '正在查看共享画面',
};

/** Product wording for the same bounded work fact used by body motion. */
export function nativeWorkLabel(snapshot, nativeActivity = 'none') {
  const kind = snapshot
    ? snapshot.work?.kind
    : nativeActivity === 'reasoning' ? 'reasoning' : nativeActivity === 'tool_running' ? 'tool' : null;
  return workLabels[kind] ?? '';
}
