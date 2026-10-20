import { fail } from './config.mjs';

export function roundProgress(state, params = new URLSearchParams()) {
  const run = state?.automation;
  if (!run) return null;
  const offset = Number(params.get('offset') ?? 0),
    limit = Number(params.get('limit') ?? 20);
  const filter = params.get('status') ?? 'all';
  if (
    [...params.keys()].some((key) => !['offset', 'limit', 'status'].includes(key)) ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !['all', 'complete', 'current', 'pending', 'cancelled'].includes(filter)
  )
    fail('INVALID_ROUND_QUERY', '本轮清单筛选或分页无效，每页最多 50 笔');
  const admitted = state.deliveries ?? [];
  const deliveries = admitted.filter(
    (d, index) =>
      d.id === run.startingDeliveryId ||
      (Number.isSafeInteger(run.startingDeliveryCount)
        ? index >= run.startingDeliveryCount
        : Date.parse(d.startedAt) >= Date.parse(run.startedAt)),
  );
  const rows = new Map();
  for (const d of deliveries)
    rows.set(
      d.target,
      row(
        d,
        d.status === 'COMPLETE'
          ? 'complete'
          : d.status === 'CANCELLED'
            ? 'cancelled'
            : d.id === state.activeId
              ? 'current'
              : 'cancelled',
      ),
    );
  for (const plan of state.queue ?? [])
    if (!rows.has(plan.target) || rows.get(plan.target).status === 'cancelled') {
      const lastAttempt = rows.get(plan.target)?.deliveryId;
      rows.set(plan.target, { ...row(plan, 'pending'), ...(lastAttempt ? { lastAttempt } : {}) });
    }
  const all = [...rows.values()];
  const total = run.scanned && Object.hasOwn(run, 'startingDeliveryId') ? all.length : null;
  const counts = Object.fromEntries(
    ['complete', 'current', 'pending', 'cancelled'].map((status) => [
      status,
      all.filter((r) => r.status === status).length,
    ]),
  );
  const selected = all.filter((r) => filter === 'all' || r.status === filter);
  return {
    runId: run.id,
    selection: run.selection,
    target: run.target ?? state.syncTarget?.commit ?? null,
    status: run.status,
    total,
    counts,
    current: all.find((r) => r.status === 'current') ?? null,
    items: selected.slice(offset, offset + limit),
    matched: selected.length,
    offset,
    limit,
  };
}
function row(item, status) {
  const source = item.source ?? {};
  return {
    target: item.target,
    status,
    source: {
      kind: source.kind,
      number: source.number,
      title: source.title,
      tag: source.tag,
      url: source.url,
    },
    ...(item.id ? { deliveryId: item.id } : {}),
    internal: item.acceptedInternal ?? item.candidate ?? null,
    prUrl: item.prUrl ?? null,
    deliveryStatus: item.status ?? null,
    issueCount: item.issues?.length ?? 0,
    commitCount:
      item.source?.developmentCommitCount ??
      item.source?.developmentReplay?.commits.length ??
      item.commits?.length ??
      null,
  };
}
