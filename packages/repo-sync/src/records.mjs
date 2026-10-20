import { fail } from './config.mjs';
import { configSnapshot } from './recording.mjs';

function queryValues(params) {
  const allowed = ['offset', 'limit', 'q', 'status', 'from', 'to', 'taskOffset'];
  if ([...params.keys()].some((key) => !allowed.includes(key)) || allowed.some((key) => params.getAll(key).length > 1))
    fail('INVALID_RECORD_QUERY', '历史查询参数无效');
  const offset = Number(params.get('offset') ?? 0);
  const limit = Number(params.get('limit') ?? 20);
  const taskOffset = Number(params.get('taskOffset') ?? 0);
  if (
    ![offset, taskOffset].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (params.get('q')?.length ?? 0) > 200
  )
    fail('INVALID_RECORD_QUERY', '每页最多 50 笔，查询长度最多 200 字符');
  validateDates(params);
  return {
    offset,
    limit,
    taskOffset,
    q: params.get('q')?.toLowerCase() ?? '',
    status: params.get('status') ?? 'all',
    from: params.get('from'),
    to: params.get('to'),
  };
}
export async function recordList(receiver, params) {
  const query = queryValues(params);
  if (!['all', 'active', 'complete', 'failed', 'cancelled'].includes(query.status))
    fail('INVALID_RECORD_QUERY', '记录状态筛选无效');
  const state = await receiver?.status();
  const records = (state?.deliveries ?? [])
    .slice()
    .reverse()
    .filter((delivery) => matches(delivery, query));
  return {
    records: records.slice(query.offset, query.offset + query.limit).map(summary),
    total: records.length,
    offset: query.offset,
    limit: query.limit,
    bindingId: receiver?.config.bindingId,
  };
}
function matches(delivery, query) {
  const complete = delivery.status === 'COMPLETE';
  if (
    (query.status === 'complete' && !complete) ||
    (query.status === 'cancelled' && delivery.status !== 'CANCELLED') ||
    (query.status === 'active' && ['COMPLETE', 'CANCELLED'].includes(delivery.status)) ||
    (query.status === 'failed' && !delivery.error)
  )
    return false;
  if (
    query.q &&
    !JSON.stringify([
      delivery.source,
      delivery.syncTarget,
      delivery.id,
      delivery.target,
      delivery.base,
      delivery.candidate,
      delivery.acceptedInternal,
      delivery.prUrl,
    ])
      .toLowerCase()
      .includes(query.q)
  )
    return false;
  const date = delivery.finishedAt ?? delivery.startedAt;
  if ((query.from || query.to) && !date) return false;
  return (!query.from || date.slice(0, 10) >= query.from) && (!query.to || date.slice(0, 10) <= query.to);
}
function summary(delivery) {
  const { id, mode, source, status, startedAt, finishedAt, target, acceptedInternal, prUrl, error } = delivery;
  return {
    id,
    mode,
    ...(delivery.syncTarget
      ? {
          syncTarget: {
            kind: delivery.syncTarget.kind,
            value: delivery.syncTarget.value,
            commit: delivery.syncTarget.commit,
            ...(delivery.syncTarget.includeDirectCommits ? { includeDirectCommits: true } : {}),
          },
        }
      : {}),
    source: { title: source.title, tag: source.tag, number: source.number, kind: source.kind, commit: source.commit },
    status,
    startedAt,
    finishedAt,
    target,
    acceptedInternal,
    prUrl,
    error: error ? { code: error.code } : undefined,
  };
}
export async function recordDetail(receiver, id, params, tasks) {
  const query = queryValues(params);
  const state = await receiver?.status();
  const delivery = state?.deliveries.find((item) => item.id === id);
  if (!delivery) fail('RECORD_NOT_FOUND', '这笔同步不存在于当前仓库，保留选择，请核对仓库与记录');
  const ids = delivery.taskIds ?? [];
  const selected = ids
    .slice()
    .reverse()
    .slice(query.taskOffset, query.taskOffset + 50);
  const loaded = await Promise.all(selected.map((taskId) => tasks.latest(taskId)));
  for (const task of loaded)
    if (task?.deliveryId && task.deliveryId !== id && !task.deliveryIds?.includes(id))
      fail('TASK_BINDING_CHANGED', '历史任务属于另一笔同步，不能混入当前记录');
  const records = loaded
    .filter(Boolean)
    .reverse()
    .map((task) => ({ ...task, steps: task.steps.filter((step) => !step.deliveryId || step.deliveryId === id) }));
  const configurations = [...(delivery.configurations ?? [])];
  for (const task of records)
    if (
      task.configSnapshot &&
      !configurations.some(
        (item) => item.snapshot.fingerprint === task.configSnapshot.fingerprint && item.taskId === task.id,
      )
    )
      configurations.push({
        time: task.startedAt,
        source: 'execution',
        taskId: task.id,
        snapshot: task.configSnapshot,
      });
  configurations.sort((a, b) => a.time.localeCompare(b.time));
  const issues = (delivery.issues ?? []).map((issue) => ({
    sourceId: issue.sourceId,
    number: issue.number,
    url: issue.url,
    relation: issue.relation,
    mapping: delivery.issueMappings?.[issue.sourceId] ?? null,
    result: delivery.issueResults?.[issue.sourceId],
  }));
  return {
    delivery,
    tasks: records,
    configurations,
    issues,
    events: state.events.filter((item) => item.deliveryId === id),
    legacy: !delivery.startedAt,
    missingTasks: selected.filter((_, index) => !loaded[index]),
    taskPage: { offset: query.taskOffset, total: ids.length, hasMore: ids.length > query.taskOffset + 50 },
    current: state.active?.id === id,
    bindingId: state.bindingId,
    currentConfiguration: state.active?.id === id ? configSnapshot(receiver.config) : undefined,
  };
}

function validateDates(params) {
  for (const key of ['from', 'to'])
    if (
      params.has(key) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(params.get(key)) ||
        !Number.isFinite(Date.parse(`${params.get(key)}T00:00:00Z`)) ||
        new Date(`${params.get(key)}T00:00:00Z`).toISOString().slice(0, 10) !== params.get(key))
    )
      fail('INVALID_RECORD_QUERY', '时间筛选需要日期');
  if (params.get('from') && params.get('to') && params.get('from') > params.get('to'))
    fail('INVALID_RECORD_QUERY', '开始日期不能晚于结束日期');
}
