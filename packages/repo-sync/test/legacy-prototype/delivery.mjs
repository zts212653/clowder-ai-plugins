import { COMPLETE } from './data.mjs';
import { internalPrHref } from './html.mjs';

export function deliveryNames(delivery, binding) {
  return {
    candidateBranch: `sync/${delivery.id}`,
    targetBranch: binding.targetBranch,
    prTitle: `[上游同步] PR #${delivery.sourcePr} · ${delivery.title}`,
  };
}
export function deliveryPhase(state, delivery) {
  if (state.active?.id === delivery.id) return state.active.phase;
  const index = state.deliveries.findIndex((item) => item.id === delivery.id);
  const accepted = state.deliveries.findIndex((item) => item.target === state.accepted);
  return index >= 0 && index <= accepted ? COMPLETE : 0;
}
export function prHref(state, number) {
  return `${internalPrHref(number)}?binding=${encodeURIComponent(state.binding.id)}`;
}
