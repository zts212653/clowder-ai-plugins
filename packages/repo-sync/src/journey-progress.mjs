// Project the full ledger, before compact status drops historical deliveries.
export function journeyProgress(state) {
  const run = state?.automation;
  if (!run) return null;
  const started = Date.parse(run.startedAt);
  const deliveries = (state.deliveries ?? []).filter(
    (item) => item.id === run.startingDeliveryId || Date.parse(item.startedAt) >= started,
  );
  const completed = new Set(deliveries.filter((item) => item.status === 'COMPLETE').map((item) => item.target)).size;
  const frozen = run.scanned && Object.hasOwn(run, 'startingDeliveryId');
  const total = frozen ? new Set([...deliveries, ...(state.queue ?? [])].map((item) => item.target)).size : null;
  return { completed, total };
}
