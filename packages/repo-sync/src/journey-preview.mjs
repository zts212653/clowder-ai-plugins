import { adoptionBaseline } from './adoption-baseline.mjs';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { discover } from './github.mjs';
import { category } from './policy.mjs';
import { freezeTag } from './tags.mjs';
import { changeList, entries, equalEntry } from './trees.mjs';
import { selectTag } from './version.mjs';

export async function inspectBaseline(receiver, input) {
  return receiver.store.locked(async () => {
    if (await receiver.read()) fail('ALREADY_ADOPTED', '绑定已启用，请查看原接收记录，不能重新登记起点。');
    const heads = await receiver.git.fetch();
    const upstream = /^[a-f0-9]{40}$/.test(input.upstream ?? '')
      ? input.upstream
      : (await freezeTag(receiver.git, input.upstream)).commit;
    let valid = true;
    try {
      await phase('baseline-check', '核验历史起点与内部当前位置（尚未启用）', () =>
        adoptionBaseline(receiver, upstream, input.internal, heads),
      );
    } catch (error) {
      if (!['BASELINE_MISMATCH', 'UNAPPROVED_DIFFERENCE'].includes(error.code)) throw error;
      valid = false;
    }
    const [source, local] = await Promise.all([
      entries(receiver.git.directory, upstream),
      entries(receiver.git.directory, heads.internal),
    ]);
    const differences = changeList(source, local, receiver.config).map((item) => ({
      ...item,
      blocking: item.category === 'upstream',
    }));
    const changed = new Map(differences.map((item) => [item.path, item]));
    const files = [...new Set([...source.keys(), ...local.keys()])].sort().map((path) => ({
      ...(changed.get(path) ?? { path, kind: 'unchanged', category: category(path, receiver.config), blocking: false }),
      sourceMode: source.get(path)?.mode ?? null,
      internalMode: local.get(path)?.mode ?? null,
      equal: equalEntry(source.get(path), local.get(path)),
    }));
    return {
      upstream,
      internal: heads.internal,
      valid,
      differences,
      files,
      bindingId: receiver.config.bindingId,
      checkedAt: new Date().toISOString(),
      readOnly: true,
    };
  });
}

// Reuse the actual planners against a detached ledger. Only Git downloads/local refs are allowed.
// Neither planner prepares candidates, executes checks, pushes, or invokes object-creation adapters.
export async function previewSync(receiver, input, options) {
  return receiver.store.locked(async () => {
    let ledger = await receiver.read();
    if (!ledger) fail('NOT_ADOPTED', '先核验并登记已有同步起点。');
    if (receiver.active(ledger)) fail('RECOVERY_FIRST', '先处理原交付，不能用新预览替代恢复。');
    ledger = structuredClone(ledger);
    // A paused admitted run also keeps its frozen queue and target.
    if (ledger.automation && ledger.automation.status !== 'COMPLETE')
      fail('RECOVERY_FIRST', '已有冻结轮次，请回到当前同步恢复原目标。');
    const detached = Object.create(receiver);
    detached.store = {
      read: async () => structuredClone(ledger),
      save: async (state) => {
        ledger = structuredClone(state);
      },
      locked: (action) => action(),
    };
    if (receiver.config.mode === 'version') await selectTag(detached, input.tag);
    else
      await discover(
        detached,
        { kind: input.targetKind ?? 'latest', value: input.targetValue },
        options?.sourceProvider,
      );
    const target = ledger.queue.at(-1)?.target ?? ledger.accepted.upstream;
    const [before, after] = await Promise.all([
      entries(receiver.git.directory, ledger.accepted.upstream),
      entries(receiver.git.directory, target),
    ]);
    return {
      readOnly: true,
      bindingId: receiver.config.bindingId,
      checkedAt: new Date().toISOString(),
      base: ledger.accepted,
      target,
      targetName: input.tag ?? ledger.syncTarget?.value ?? '扫描时最新版本',
      plans: ledger.queue.map((plan) => ({ source: plan.source, target: plan.target, issues: plan.issues })),
      changes: changeList(before, after, receiver.config),
      internalPaths: receiver.config.internalPaths,
    };
  });
}
