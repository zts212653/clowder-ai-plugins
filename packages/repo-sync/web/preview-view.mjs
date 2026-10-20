import { fileTree } from './files.mjs';
import { esc, sha, when } from './ui.mjs';

export function previewPanel(report) {
  const issues = report.plans.flatMap((plan) => plan.issues ?? []);
  return `<section class="card" id="sync-preview"><span class="badge">只读对比 · 尚未发起同步</span><h2>对比目标范围</h2><p>${esc(report.targetName)} · ${sha(report.base.upstream)} → ${sha(report.target)}<br>内部位置 ${sha(report.base.internal)} · 读取于 ${when(report.checkedAt)}</p><p class="note-line">${report.plans.length} 笔来源；${issues.length} 个关联 Issue；${report.changes.length} 个外部变化路径，其中 ${report.changes.filter((item) => item.category === 'internal').length} 个路径将保留内部，跳过外部更新。</p>
  <div class="v3-freeze"><div class="v3-freeze-head"><b>冻结范围 · PR 与 Issue</b><span>边界与 Issue 一起进入队列；Issue 只做映射，不镜像评论/附件</span></div>${report.plans.map((plan) => {
    const label = plan.source.kind === 'commit' ? 'main commit' : plan.source.tag ? `版本 ${plan.source.tag}` : `PR #${plan.source.number}`;
    const issue = plan.issues?.length
      ? plan.issues.map((item) => `<span class="issue">#${esc(item.number)} ${esc(item.title)} · 映射待创建</span>`).join('')
      : '<span class="issue">无关联 Issue · 按直接主干提交处理</span>';
    return `<div class="v3-freeze-row"><span class="no">${esc(plan.source.kind === 'commit' ? 'commit' : plan.source.tag ? 'tag' : 'PR')}</span><span class="tt">${esc(label)} · ${esc(plan.source.title ?? '')}${issue}</span><span class="st">${sha(plan.target)}<br>${plan.issues?.length ? `${plan.issues.length} Issue` : '无 Issue'}</span></div>`;
  }).join('') || '<div class="v3-freeze-row"><span class="tt">未发现需要接收的更新。</span></div>'}</div>
  ${fileTree(report.changes, '上游变化与处理范围')}<p>只进行了读取和本地 Git 缓存；没有推送、创建或关闭远端对象。写权限和项目检查尚未验证。真正同步会重新核验目标、配置和内部 HEAD，不能将此对比当作已接收结果。</p></section>`;
}
