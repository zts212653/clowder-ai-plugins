import { esc, sha, title } from './ui.mjs';

export function runHero(snapshot, delivery) {
  const run = snapshot.state?.automation;
  const progress = snapshot.journeyProgress;
  const completed = progress?.completed ?? snapshot.state?.deliveryCount ?? 0;
  const total = progress?.total ?? null;
  const status = delivery?.status ?? run?.status ?? 'RUNNING';
  const waiting = status === 'WAITING_APPROVAL';
  const done = status === 'COMPLETE' || run?.status === 'COMPLETE';
  const failed = status === 'FAILED' || run?.status === 'FAILED' || Boolean(delivery?.error);
  const label = done ? '本轮完成' : failed ? '异常暂停' : waiting ? '等待审核' : '执行中';
  const tone = done ? 'done' : failed ? 'err' : waiting ? 'wait' : 'run';
  const current = Math.max(1, total ? Math.min(completed + (done ? 0 : 1), total) : completed + 1);
  const totalText = total === null ? `${completed} 笔已接收` : `${completed} / ${total}`;
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const deliveryTitle = delivery ? title(delivery) : '本轮同步';
  return `<section class="v3-run-hero ${tone}" aria-label="本轮同步进度"><div class="v3-run-copy"><p class="v3-eyebrow">同步工作台 · 第 04 轮</p><h2>${done ? '本轮已完成' : failed ? '当前步骤需要处理' : waiting ? '等待平台审核' : total ? `第 ${current} 笔，共 ${total} 笔` : `正在同步第 ${current} 笔`}</h2><p>${esc(deliveryTitle)} · ${esc(statusText(status))}</p><div class="v3-run-meta"><span>目标 <b>${sha(snapshot.state?.syncTarget?.commit ?? snapshot.state?.latest)}</b></span><span>已接收 <b>${totalText}</b></span><span>内部 PR <b>${delivery?.prUrl ? '已创建' : '待创建'}</b></span><span>Issue <b>${delivery?.issues?.length ?? 0}</b></span></div></div><div class="v3-ring" style="--p:${percent}"><b>${percent}%</b><span>${done ? '已完成' : '已接收'}</span></div></section>`;
}
function statusText(status) {
  return (
    {
      WAITING_APPROVAL: '内部 PR 已创建，等待平台审批与合入',
      COMPLETE: '代码、Issue 与接收位置均已保存',
      FAILED: '原对象与已完成结果保留，按当前步骤恢复',
      ISSUES_REQUIRED: 'Issue 映射与候选准备中',
      CODE_PREPARE_REQUIRED: '候选已构造，等待检查与推送',
      PR_REQUIRED: '候选已发布，等待登记 PR',
    }[status] ?? '系统正在推进当前步骤'
  );
}
