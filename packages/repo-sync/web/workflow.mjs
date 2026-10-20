import { actionBar } from './actionbar.mjs';
import { runHero } from './v3-hero.mjs';
import { attempts, stageSummary } from './attempts.mjs';
import { deliveryOverview } from './delivery-overview.mjs';
import { facts } from './stage-facts.mjs';
export { attempts, actionBar };

import { nextAction } from './action-policy.mjs';
import { closureSettings } from './closure-settings.mjs';
import { diagnostics } from './diagnostics.mjs';
import { errorGuide } from './error-guide.mjs';
import { currentStage, stagePresentation } from './flow-stage.mjs';
import { authenticationForm } from './issue-auth.mjs';
import { autoIssuePanel } from './issue-settings.mjs';
import { issueForms } from './issues.mjs';
import { panorama } from './panorama.mjs';
import { prPanel } from './pr.mjs';
import { receiptFields } from './receipts.mjs';
import { completionTime, esc, labels, sha, stageOf, title, when } from './ui.mjs';

const names = ['确认范围', '准备交付', '发布 PR', '审核合入', '核验接收'];

export function workflow(snapshot, record, historical) {
  const delivery = record?.delivery ?? snapshot.state.active;
  const policy = nextAction(snapshot, delivery, historical);
  const current = currentStage(delivery, policy, historical);
  const failure = stageFailure(snapshot, record, delivery, historical);
  const failedStage = failure?.stage ?? 0;
  return `${historical ? '' : runHero(snapshot, delivery)}${deliveryOverview(snapshot, record, delivery, historical)}<div class="detail-head"><span class="badge">${historical ? '历史记录 · 只读' : '当前同步'}</span><h2>${esc(title(delivery))} · ${esc(labels[delivery.status] ?? delivery.status)}</h2><div class="v3-baseline-strip"><div class="v3-base"><span class="v3-base-k">外部</span>${sha(delivery.base.upstream)}<b>→</b>${sha(delivery.target)}</div><div class="v3-base"><span class="v3-base-k">内部</span>${sha(delivery.base.internal)}<b>→</b>${sha(delivery.acceptedInternal ?? '待接受')}</div></div><details class="delivery-boundary" data-persist-details="boundary"><summary>查看内外基线与提交位置</summary><p>外部 ${sha(delivery.base.upstream)} → ${sha(delivery.target)}<br>内部 ${sha(delivery.base.internal)} → ${sha(delivery.acceptedInternal ?? '待接受')}</p></details><details class="execution-meta" data-persist-details="execution-meta"><summary>技术详情 · 同步标识与时间</summary><p>同步标识 ${esc(delivery.id)}<br>开始 ${when(delivery.startedAt)} · 结束 ${when(completionTime(delivery, record))}${!delivery.finishedAt && completionTime(delivery, record) ? '（接收事件时间）' : ''}</p></details><div class="workflow-controls"><span class="workflow-controls-hint">先看当前状态；需要排障时再展开技术详情。</span>${historical ? '<button type="button" data-record="current">返回当前同步</button>' : ''}<button type="button" data-expand-all>展开全部阶段</button><button type="button" data-collapse-all>全部收起</button></div></div>${record?.legacy ? '<p class="record-gap">此为旧记录：未记录的时间、配置或任务关联保持“未记录”，不会用当前配置补齐。</p>' : ''}${record?.missingTasks.length ? `<p class="record-gap bad">× ${record.missingTasks.length} 份关联执行记录缺失。业务结果保留，不能补造时间线。</p>` : ''}${actionBar(policy, historical, snapshot)}${panorama(snapshot, record, historical)}<section id="flow-inspector" class="flow-inspector" aria-label="选中节点的执行详情"><p data-flow-inspector-hint>点击上方阶段查看业务步骤；执行详情只在需要排障时展开。</p><ol class="journey-flow">${names
    .map((name, index) =>
      stageView(
        index + 1,
        name,
        snapshot,
        record,
        delivery,
        historical,
        policy,
        current,
        failedStage,
        failure,
      ),
    )
    .join('')}</ol></section>`;
}
function stageForm(stage, delivery, snapshot) {
  if (stage === 2 && delivery.status === 'CODE_PREPARE_REQUIRED')
    return '<button type="button" data-action="cancel-version">撤销未发布交付，重新选择版本</button><p>历史保留，已发布候选不能直接撤销。</p>';
  if (stage === 2 && delivery.status === 'ISSUES_REQUIRED')
    return `${closureSettings(snapshot, esc)}${authenticationForm(snapshot.config)}<div id="issue-mappings">${snapshot.config?.issueAutomation?.automatic ? autoIssuePanel(delivery, snapshot.state, esc) : issueForms(delivery, snapshot.state, esc)}</div>`;
  if (stage === 3 && ['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status))
    return prPanel(snapshot, esc);
  if (stage === 5 && delivery.status === 'CODE_ACCEPTED_PENDING_METADATA')
    if (snapshot.config?.issueAutomation?.automatic)
      return '<div id="receipt-form"><h3>代码已接收，继续核对原 Issue</h3><p>程序核验原 PR 关联、检查全部 required commits 后关闭应关闭的 Issue，并回读平台状态。不会重新推送候选或创建 PR。</p><button type="button" class="primary" data-action="sync-issues">回读 / 更新原 Issue，保存接收结果</button></div>';
  if (stage === 5 && delivery.status === 'CODE_ACCEPTED_PENDING_METADATA')
    return `<div id="receipt-form"><form data-form="receipts"><h3>确认平台实际状态并保存接收记录</h3>${receiptFields(delivery, snapshot.state, esc, sha)}<button type="submit" class="primary">保存本笔接收记录，完成同步</button><p>此操作记录人工核对结果，不向内部平台发送关单请求。</p></form></div>`;
  return '';
}

function stageView(
  stage,
  name,
  snapshot,
  record,
  delivery,
  historical,
  policy,
  current,
  failedStage,
  failure,
) {
  const {
    state: status,
    mark,
    tone,
    caption,
  } = stagePresentation(
    stage,
    delivery,
    current,
    failedStage,
    historical ? undefined : snapshot.state?.automation,
  );
  const detail = stageSummary(stage, record, snapshot.operation, historical, snapshot, status);
  return `<li><details data-stage="${stage}" data-stage-state="${status}"><summary><span class="stage-mark ${tone}">${mark}</span><b>${stage} · ${name}</b><span data-stage-caption>${caption}</span><small data-stage-detail>${esc(detail)}</small></summary><div class="stage-body"><div data-attempts-stage="${stage}">${attempts(stage, record, snapshot.operation, historical, snapshot)}</div>${stageError(stage, failedStage, failure, historical, snapshot, record)}${facts(stage, delivery, record, historical, snapshot)}${editableStage(stage, delivery, snapshot, historical)}${errorSlot(stage, historical, policy)}${moreTasks(stage, record)}</div></details></li>`;
}
function stageError(stage, failedStage, failure, historical, snapshot, record) {
  if (stage !== failedStage || !failure) return '';
  const represented = [
    ...(record?.tasks ?? []),
    ...(!historical && snapshot.operation ? [snapshot.operation] : []),
  ].some(
    (task) =>
      task.persistence?.error?.code === failure.error.code ||
      task.steps?.some((step) => step.stage === stage && step.error?.code === failure.error.code),
  );
  return `${represented ? '' : errorGuide(failure.error, { stage, deliveryId: record?.delivery?.id, historical })}${historical ? '' : diagnostics(failure.error, snapshot, esc)}`;
}
function editableStage(stage, delivery, snapshot, historical) {
  if (historical || delivery.id !== snapshot.state?.active?.id) return '';
  if (snapshot.state?.automation && snapshot.state.automation.status !== 'COMPLETE')
    return stage === 3 ? prPanel(snapshot, esc) : '';
  return stageForm(stage, delivery, snapshot);
}
function errorSlot(stage, historical, policy) {
  return !historical && stage === policy.stage ? '<div id="error-slot"></div>' : '';
}
function moreTasks(stage, record) {
  return stage === 5 && record?.taskPage?.hasMore
    ? '<button type="button" data-more-tasks>加载更早的执行记录</button>'
    : '';
}

function stageFailure(snapshot, record, delivery, historical) {
  const task = snapshot.operation;
  if (!historical && (task?.deliveryId === delivery.id || task?.deliveryIds?.includes(delivery.id))) {
    if (task.persistence?.status === 'FAILED') return { stage: 5, error: task.persistence.error };
    const failed = task.steps?.findLast((step) => step.status === 'FAILED');
    if (task.status === 'FAILED' && (task.error || failed?.error))
      return {
        stage: failed?.stage || nextAction(snapshot, delivery).stage,
        error: task.error ?? failed.error,
      };
  }
  const recorded = record?.tasks
    ?.flatMap((item) => item.steps ?? [])
    .findLast((step) => step.status === 'FAILED');
  return delivery.error
    ? {
        stage: historical ? (recorded?.stage ?? stageOf(delivery)) : nextAction(snapshot, delivery).stage,
        error: delivery.error,
      }
    : null;
}
