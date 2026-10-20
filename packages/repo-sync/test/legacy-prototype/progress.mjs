import { COMPLETE } from './data.mjs';
import { deliveryPhase } from './delivery.mjs';
import { escapeHtml } from './html.mjs';
import { issueRelation, issueSummary } from './issues.mjs';

const groups = [
  [
    '准备同步',
    [
      [1, '校验并冻结目标'],
      [2, '创建 / 复用内部 Issue'],
      [3, '搬运提交与候选分支'],
      [4, '创建 / 复用内部 PR'],
      [5, '运行代码与插件检查'],
    ],
  ],
  ['审核 PR', [[6, '审核并合入内部 PR']]],
  [
    '核验代码',
    [
      [7, '读取 PR 合入结果', true],
      [7, '核验文件树与提交'],
    ],
  ],
  [
    '更新 Issue 接收状态',
    [
      [8, '读取内部 Issue 状态', true],
      [8, '保存接收记录并核对状态'],
    ],
  ],
  ['完成', [[9, '记录结果并开放下一笔']]],
];
const failures = {
  drift: {
    code: 'CORE_BASELINE_MISMATCH',
    message: '内部核心文件树与已接受上游基线不一致。',
    detail: '演示差异：core/config.ts 存在内部修改。确认 A/B 对应并将定制移至独立插件后重新核验。',
  },
  timeout: {
    code: 'PR_CREATE_TIMEOUT',
    message: '创建内部 PR 的命令超时，创建结果尚未确认。',
    detail: '内部 PR 可能已经创建。先按交付 ID 与候选分支查回结果，复用既有 PR 后继续。',
  },
  plugin: {
    code: 'PLUGIN_INCOMPATIBLE',
    message: '独立插件兼容检查失败。',
    detail: '演示报错：定制插件依赖的 core.loadLegacy 接口在目标版本中不存在。修复插件后重跑检查。',
  },
  metadata: {
    code: 'ISSUE_CLOSE_FAILED',
    message: '内部 Issue 仍为打开状态，关单操作尚未完成。',
    detail: '演示报错：平台关单请求返回 503。代码已合入且核验通过，重试本次已映射 Issue 的关单，不重复搬运或合入。',
  },
  recovery: {
    code: 'ACCEPTANCE_RECORD_MISSING',
    message: '内部 PR 已合入，但上一次执行未保存接受版本。',
    detail: '先核对原交付的真实结果；核验通过后补写 U/A，再补接收记录。不能直接当成核心漂移或重复合入。',
  },
};
export function stepFailure(delivery) {
  if (!delivery?.block) return null;
  return delivery.error ? { ...delivery.error } : failures[delivery.block];
}
function childStatus(step, phase, failed) {
  const [number, , doneOnEntry] = step;
  if (phase === COMPLETE || phase > number || (doneOnEntry && phase >= number)) return 'done';
  if (phase === number) return failed ? 'failed' : 'current';
  return 'pending';
}
function child(step, phase, failed) {
  const status = childStatus(step, phase, failed);
  const labels = { done: '已完成', current: '执行中', failed: '异常', pending: '待执行' };
  const marks = { done: '✓', current: '●', failed: '×', pending: '○' };
  return `<li data-step="${step[0]}" data-step-status="${status}" class="substep ${status}" title="${labels[status]}"><b aria-label="${labels[status]}">${marks[status]}</b><span>${step[1]}</span></li>`;
}
function group([label, steps], index, phase, failed) {
  const first = steps[0][0];
  const last = steps.at(-1)[0];
  const done = phase > last || phase === COMPLETE;
  const current = phase >= first && phase <= last && !done;
  const status = done ? 'done' : current ? (failed ? 'failed' : 'current') : '';
  return `<li class="${status}"><div class="milestone-heading"><b>${done ? '✓' : current && failed ? '×' : index + 1}</b><span>${label}</span></div><ol class="milestone-children">${steps.map((step) => child(step, phase, failed)).join('')}</ol></li>`;
}
function issueExplanation(delivery, phase) {
  if (phase < 8) return '';
  if (delivery.error?.code === 'ISSUE_MAPPING_UNVERIFIED')
    return '<div class="issue-explanation"><strong>关单已暂停</strong><p>先核对本次交付的内外 Issue 对应与代码核验记录。检查通过后才允许关闭，当前保留 Issue 状态。</p></div>';
  const ordinary = issueRelation(delivery) === 'related';
  return `<div class="issue-explanation"><strong>外部 Issue #${delivery.issue} → 内部 #${delivery.internalIssue}：准备阶段已完成创建与映射</strong><p>${escapeHtml(issueSummary(delivery, phase))}。${ordinary ? '本次交付只关联此 Issue，确认状态后登记完成。' : '本笔完成表示接收记录已保存；有后续交付时保持打开，全部接收后才确认或补齐关单。'}</p></div>`;
}
export function renderProgress(state, delivery) {
  const phase = deliveryPhase(state, delivery);
  const actual = state.active?.id === delivery.id ? state.active : delivery;
  const error = stepFailure(actual);
  return `<div class="progress-tree"><ol class="milestones" aria-label="同步进度与子步骤">${groups.map((item, index) => group(item, index, phase, Boolean(error))).join('')}</ol><div class="progress-legend">✓ 已完成 · ● 执行中 · ○ 待执行 · × 异常</div>${error ? `<div class="step-failure" role="alert" data-step-error="${phase}"><strong>× ${escapeHtml(groups.flatMap((item) => item[1]).find((step) => step[0] === phase && !step[2])?.[1])}：${escapeHtml(error.code)}</strong><p>${escapeHtml(error.message)}</p>${error.detail ? `<p>${escapeHtml(error.detail)}</p>` : ''}<small>演示错误信息 · 当前未执行真实命令</small></div>` : ''}${issueExplanation(actual, phase)}</div>`;
}
