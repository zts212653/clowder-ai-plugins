import { fail } from './config.mjs';

export const continuationModes = new Set(['automatic', 'after-each']);
export function armBoundary(run, active) {
  if (run.continuation === 'after-each' && active && !run.pauseRequested)
    run.pauseRequested = { afterDeliveryId: active.id, requestedAt: new Date().toISOString() };
}
export function boundaryReached(receiver, state) {
  return Boolean(state.automation?.pauseRequested && !receiver.active(state));
}
export function configureContinuation(receiver, input) {
  if (!continuationModes.has(input.continuation)) fail('INVALID_CONTINUATION', '请选择连续处理或每笔核验后暂停。');
  return receiver.change((state) => {
    const run = state.automation;
    if (!run || run.id !== input.runId) fail('AUTOMATION_CHANGED', '原同步轮次已改变，未调整其他轮次。');
    run.continuation = input.continuation;
    if (input.continuation === 'automatic') {
      if (run.status !== 'PAUSED') delete run.pauseRequested;
    } else {
      const active = receiver.active(state);
      armBoundary(run, active);
      if (!active && run.status !== 'COMPLETE') {
        run.status = 'PAUSED';
        run.pauseRequested ??= { afterDeliveryId: null, requestedAt: new Date().toISOString() };
      }
    }
    run.updatedAt = new Date().toISOString();
    // Changing preference is not authorization to release an existing paused boundary.
  });
}

// Recheck admission within Receiver.start's own ledger lock. The start implementation
// remains authoritative; only its lock and save boundaries gain the continuation guard.
export async function startNext(receiver, target, runId) {
  const guarded = Object.create(receiver);
  guarded.store = Object.create(receiver.store);
  guarded.store.locked = (action) =>
    receiver.store.locked(async () => {
      const state = await receiver.read();
      if (state.automation?.id !== runId) fail('AUTOMATION_CHANGED', '同步轮次已改变，未启动下一笔。');
      if (state.automation.status === 'PAUSED' || boundaryReached(receiver, state)) return state;
      return action();
    });
  guarded.store.save = async (state) => {
    armBoundary(state.automation, guarded.active(state));
    return receiver.store.save(state);
  };
  return guarded.start(target);
}
