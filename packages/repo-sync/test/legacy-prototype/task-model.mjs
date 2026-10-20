import { COMPLETE, phases } from './data.mjs';
import { deliveryPhase, prHref } from './delivery.mjs';
import { summary } from './state.mjs';

export function taskContext(state) {
  if (state.binding.status !== 'ready') return null;
  if (state.active && state.active.phase < COMPLETE) return state.active;
  const index = state.deliveries.findIndex((item) => item.target === state.accepted);
  return state.deliveries[index + 1] ?? state.active ?? state.deliveries[index];
}
const result = (actor, title, description, action, tone = 'warm') => ({ actor, title, description, action, tone });
function blockedTask(active) {
  const blocks = {
    timeout: [
      '系统需要重新查询',
      '内部 PR 创建结果待确认',
      '上次创建命令超时。重新查询已有 PR，确认后继续，避免重复创建。',
      '重新查询内部 PR',
    ],
    plugin: [
      '需要处理插件检查',
      '插件兼容检查未通过',
      '核心代码检查通过。修复独立插件后重跑检查；演示按钮模拟重跑成功。',
      '模拟重跑插件检查',
    ],
    metadata: [
      '系统需要重试',
      '代码已同步，Issue 状态待补齐',
      '只需重试核对内部 Issue，不会再次搬运或合入代码。',
      '重试核对 Issue',
    ],
    recovery: [
      '系统需要核对合入结果',
      '内部 PR 已合入，接收记录待恢复',
      '先回读原 PR、冻结候选和实际 main。确认属于同一交付后补写两侧接受版本，再继续更新 Issue；结果冲突时暂停。',
      '核对合入结果并恢复',
    ],
  };
  if (active.block === 'drift')
    return result(
      '需要你处理',
      '同步暂停：内部核心基线不一致',
      '先核对内部核心仓的差异，确认基线后再同步。点击查看具体处理方法。',
      { id: 'inspect-drift', label: '查看基线处理方法', help: active.id },
      'bad',
    );
  const [actor, title, description, label] = blocks[active.block];
  return result(actor, title, description, { id: 'recover', label }, 'bad');
}
function setupTask(binding) {
  if (binding.status === 'saved' && binding.mode === 'adopt')
    return result(
      '还差一步',
      '已有仓库连接已保存，确认基线后启用',
      '登记外部 A 与内部 B 的对应，之后接收 A 之后的更新。演示使用模拟核验结果。',
      { view: 'configuration', label: '继续确认基线 →' },
    );
  return binding.status === 'saved'
    ? result('还差一步', '连接已保存，完成初始化即可使用', '继续确认起始版本并完成模拟初始化，之后就能接收上游更新。', {
        view: 'configuration',
        label: '继续初始化 →',
      })
    : result(
        '首次使用',
        '先连接外部和内部仓库',
        '填写两个仓库地址，选择从哪个上游版本开始。配置完成后，在这里发起同步。',
        { view: 'configuration', label: '开始配置仓库 →' },
      );
}
function historyTask(phase) {
  return result(
    '查看同步记录',
    phase === COMPLETE ? '这笔同步已完成' : '这笔更新仍在排队',
    phase === COMPLETE
      ? '可以展开审计，查看这笔同步的处理过程。回到工作台继续当前操作。'
      : '先完成当前同步，再按上游顺序接收这一笔更新。',
    { view: 'overview', label: '返回同步工作台 →' },
    phase === COMPLETE ? 'good' : 'neutral',
  );
}
export function taskModel(state, delivery, detailsOpen = false) {
  if (state.binding.status !== 'ready') return setupTask(state.binding);
  const active = state.active;
  const phase = delivery ? deliveryPhase(state, delivery) : 0;
  if (detailsOpen && (phase === COMPLETE || (active && active.phase < COMPLETE && active.id !== delivery?.id)))
    return historyTask(phase);
  if (!active || active.phase === COMPLETE)
    return summary(state).behind
      ? result(
          '轮到你开始',
          '有新的上游更新可以同步',
          `下一笔是外部 PR #${delivery.sourcePr}。点击后系统准备提交与 Issue，并创建内部 PR；审核合入前，内部目标分支不变。`,
          { id: 'start', label: `同步上游 PR #${delivery.sourcePr} →` },
        )
      : result(
          '全部完成',
          '内部已接收外部最新版本',
          '没有待处理的同步。需要回看过程时，可以打开最近的同步记录。',
          { delivery: delivery.id, label: '查看最近同步记录 →' },
          'good',
        );
  if (active.block) return blockedTask(active);
  if (active.phase < 6)
    return result(
      '系统正在处理',
      '正在准备内部 PR',
      `当前正在${phases[active.phase]}。下方展示各项操作的状态；点击继续，查看下一步结果。正式系统自动执行。`,
      { id: 'advance', label: '继续演示：执行下一步 →' },
    );
  if (active.phase === 6)
    return result(
      '需要你审核',
      '到内部 PR 完成审核',
      '同步内容已准备好并通过检查。打开 PR 查看变更，在内部平台审核并合入，然后回到这里继续。',
      { id: 'open-pr', href: prHref(state, active.internalPr), label: `打开内部 PR #${active.internalPr} ↗` },
    );
  const verifying = active.phase === 7;
  return result(
    '系统正在检查',
    verifying ? 'PR 已合入，系统正在核验代码' : '代码核验通过，更新 Issue 接收状态',
    '正式系统自动完成这一环节。演示暂停在这里，点击下方按钮模拟结果并继续。',
    { id: 'auto-step', label: verifying ? '继续演示：核验通过 →' : '继续演示：完成同步 →' },
  );
}
