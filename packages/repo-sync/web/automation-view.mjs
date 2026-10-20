import { actionBar } from './actionbar.mjs';
import { attempts, stageSummary } from './attempts.mjs';
import { preDeliveryPresentation } from './flow-stage.mjs';
import { panorama } from './panorama.mjs';
import { esc, sha, title, when } from './ui.mjs';
import { runHero } from './v3-hero.mjs';

export function automationBanner(snapshot) {
  const run = snapshot.state?.automation;
  if (!run) return '';
  const version = snapshot.config.mode === 'version';
  const path = version
    ? '读取 tag → 保留内部文件并检查 → 自动创建 PR → 人工合入 → 自动核验与保存版本'
    : 'Issue 搬运 → 提交与检查 → 自动创建 PR → 人工合入 → 自动核验与关单 → 下一笔';
  const labels = {
    RUNNING: '自动执行中',
    WAITING_REVIEW: run.autoMerge ? '自动观察平台合入条件' : '等待你在内部平台审核合入',
    FAILED: '异常暂停 · 原记录可恢复',
    PAUSED: '已暂停自动继续',
    COMPLETE: '本轮自动同步完成',
  };
  const error = run.error ?? snapshot.observation?.error;
  const current = snapshot.state.active;
  const currentLabel = current
    ? `<p><b>当前${snapshot.journeyProgress ? `第 ${snapshot.journeyProgress.completed + 1} 笔` : '同步'} · ${esc(title(current))}</b></p>`
    : run.restartOf && run.status === 'PAUSED'
      ? '<p><b>原 PR 已撤销，接受基线未变；确认后重新读取原目标并准备新的 PR。</b></p>'
      : run.status === 'PAUSED'
        ? `<p><b>${run.pauseRequested?.afterDeliveryId ? '上一笔接收已结束，停在两笔之间；下一笔尚未开始。' : '本轮已暂停，尚未开始首笔交付。'}</b></p>`
        : '';
  const progress = snapshot.journeyProgress;
  const count = progress
    ? `<p class="note-line">${progress.total === null ? `已完整接收 ${esc(progress.completed)} 笔；总数尚未确定` : `已完整接收 ${esc(progress.completed)} / ${esc(progress.total)} 笔`} · 创建 PR 或代码已接收但元数据待处理不计完成。</p>`
    : '';
  return `<section class="card automation-status" role="status"><h3>${labels[run.status]}</h3>${currentLabel}<p>同步轮次 ${esc(run.id)} · 开始 ${when(run.startedAt)}<br>${path}</p>${count}${run.status === 'WAITING_REVIEW' ? `<p>后台每 10 秒观察内部合入分支；无需手动核验，关闭页面仍会继续。最近检查 ${when(snapshot.observation?.lastCheckedAt)}</p>` : ''}${error ? `<p class="bad">× ${esc(error.code)}：${esc(error.message)}</p>` : ''}</section>`;
}
export function automaticPolicy(snapshot, delivery) {
  const run = snapshot.state?.automation;
  if (!run || run.status === 'COMPLETE') return null;
  if (run.status === 'PAUSED' && run.restartOf && !snapshot.state.active)
    return {
      stage: 1,
      outcome: 'cancelled',
      text: '旧 PR 已关闭，Issue 与历史保留。明确继续后重新读取原目标、创建新的候选和 PR。',
      action: 'resume-sync',
      label: '重新读取目标并同步本笔 →',
    };
  const reference = referenceRemedy(delivery);
  if (reference) return reference;
  if (run.status === 'PAUSED' && !snapshot.state.active && run.pauseRequested)
    return {
      stage: run.pauseRequested.afterDeliveryId ? 5 : 1,
      text: run.pauseRequested.afterDeliveryId
        ? '上一笔的合入核验、Issue 和结果已处理；下一笔未开始。确认后继续下一笔，接收节奏保持不变。'
        : '尚未开始首笔交付，确认后继续原轮次。',
      action: 'resume-sync',
      label: '继续下一笔同步 →',
    };
  if (run.status === 'PAUSED')
    return {
      stage: delivery?.acceptedInternal ? 5 : delivery?.prUrl ? 4 : delivery?.candidate ? 3 : 2,
      text: '原轮次已暂停，保留当前候选和对象，恢复后继续原位置。',
      action: 'resume-sync',
      label: '恢复原同步 →',
    };
  if (run.status === 'FAILED')
    return {
      stage: delivery?.acceptedInternal ? 5 : delivery?.prUrl ? 4 : delivery?.candidate ? 3 : 2,
      text: '修正当前错误后恢复原轮次，保留已创建的 Issue、候选和 PR。',
      action: 'resume-sync',
      label: '恢复原同步 →',
    };
  if (run.status === 'WAITING_REVIEW')
    return {
      stage: 4,
      text:
        run.autoMerge === true
          ? `${delivery?.autoMerge?.reason ?? '正在核对平台 CI 与合入条件'}。系统观察同一 PR，确认合入后自动核验接收结果。${run.pauseRequested ? '本笔完成后暂停。' : ''}`
          : snapshot.config.mode === 'version'
            ? '只需在内部平台审核合入，后台自动核验并保存版本结果；此模式不搬运 Issue。'
            : `只需在内部平台审核合入。后台会自动核验、按接收条件关单，${run.pauseRequested || run.continuation === 'after-each' ? '本笔完成后暂停，确认继续才开始下一笔。' : '再处理下一笔。'}`,
      href: delivery?.prUrl,
      label: '打开内部 PR ↗',
    };
  return {
    stage: delivery?.acceptedInternal ? 5 : delivery?.prUrl ? 4 : delivery?.candidate ? 3 : 2,
    text: '系统正在自动执行，当前子步骤会在流程内显示。',
  };
}

export function preDeliveryFlow(snapshot, policy = automaticPolicy(snapshot, null)) {
  const task = snapshot.operation;
  const current = preDeliveryPresentation(0, task, policy).current;
  const version = snapshot.config.mode === 'version';
  const names = [
    '确认范围',
    '准备交付',
    '发布 PR',
    '审核合入',
    '核验接收',
  ];
  return `${runHero(snapshot, snapshot.state?.active)}${automationBanner(snapshot)}${policy?.outcome === 'cancelled' ? `<p class="cancelled-notice">上一笔已撤销，未合入；接受基线未变。<button type="button" data-record="${esc(snapshot.state.automation.restartOf)}">查看已撤销记录</button></p>` : ''}${actionBar(policy, false, snapshot)}${panorama(snapshot, null, false)}${freezeScope(snapshot)}<section id="flow-inspector" class="flow-inspector" aria-label="选中节点的执行详情"><p data-flow-inspector-hint>选择上方节点查看读取结果和恢复操作。</p><ol class="journey-flow">${names
    .map((name, index) => {
      const stage = index + 1;
      const presentation = preDeliveryPresentation(stage, task, policy);
      const status = presentation.state,
        failed = status === 'failed',
        done = status === 'done';
      const detail = stageSummary(stage, null, task, false, snapshot, status);
      return `<li><details data-stage="${stage}" data-stage-state="${status}"><summary><span class="stage-mark ${failed ? 'bad' : done ? 'good' : ''}">${presentation.mark}</span><b>${stage} · ${name}</b><span data-stage-caption>${presentation.caption}</span><small data-stage-detail>${esc(detail)}</small></summary><div class="stage-body"><div data-attempts-stage="${stage}">${attempts(stage, null, task, false, snapshot)}</div>${stage === current ? '<div id="error-slot"></div>' : ''}</div></details></li>`;
    })
    .join('')}</ol></section>`;
}

function referenceRemedy(delivery) {
  if (
    delivery?.prReference?.withdrawn ||
    ['GIT_PR_LINK_UNKNOWN', 'GIT_PR_RESPONSE_AMBIGUOUS', 'PR_CREATE_RESULT_UNKNOWN'].includes(
      delivery?.error?.code,
    )
  )
    return {
      stage: 3,
      text: '先核对平台中已经创建的 PR，补登记原对象后恢复；不会创建第二个 PR。',
      anchor: 'pr-form',
      label: '补登记原 PR 引用 →',
    };
  return null;
}
function freezeScope(snapshot) {
  const queue = snapshot.state?.queue ?? [];
  if (!queue.length || snapshot.state?.active) return '';
  const rows = queue.slice(0, 5).map((plan) => {
    const source = plan.source.kind === 'commit' ? 'main commit' : plan.source.tag ? `版本 ${plan.source.tag}` : `PR #${plan.source.number}`;
    const issues = plan.issues ?? [];
    return `<div class="v3-freeze-row"><span class="no">${plan.source.kind === 'commit' ? 'commit' : plan.source.tag ? 'tag' : 'PR'}</span><span class="tt">${esc(source)} · ${esc(plan.source.title ?? '')}${issues.length ? issues.map((issue) => `<span class="issue">#${esc(issue.number)} ${esc(issue.title)} · 映射待创建</span>`).join('') : '<span class="issue">无关联 Issue · 直接主干提交</span>'}</span><span class="st">${sha(plan.target)}<br>${issues.length ? `${issues.length} Issue` : '无 Issue'}</span></div>`;
  }).join('');
  return `<section class="card v3-freeze" aria-label="冻结范围"><div class="v3-freeze-head"><b>冻结范围 · PR 与 Issue</b><span>${queue.length} 笔 · 边界与 Issue 已进入队列；尚未创建 PR</span></div>${rows}${queue.length > 5 ? `<div class="v3-freeze-row"><span class="tt">还有 ${queue.length - 5} 笔未展开</span></div>` : ''}</section>`;
}
