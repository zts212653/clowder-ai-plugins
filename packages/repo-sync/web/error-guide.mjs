import { repairButton } from './recovery-navigation.mjs';
import { esc } from './ui.mjs';

const guides = [
  [
    /BASELINE_MISMATCH|TREE_MISMATCH|UNAPPROVED_DIFFERENCE|CORE_DRIFT/,
    '核心文件有未处理差异',
    '查看本步骤的文件树与两侧内容。启用前明确保留路径并重新核验；启用后先通过内部修复 PR 对齐核心内容，不重置接收基线。',
  ],
  [
    /STALE_INTERNAL_HEAD/,
    '内部位置已变化',
    '重新读取内部当前合入分支 HEAD；外部历史起点仍保持上次已接收版本，再核验差异。',
  ],
  [
    /GITHUB_(AUTH|ACCESS)/,
    'GitHub 读取认证需要处理',
    '在当前项目补充 GitHub 读取 Token，完成只读检查后恢复原轮次。Git 登录不能代替 API 令牌。',
  ],
  [
    /ISSUE_(AUTH|API_REJECTED)|PR_API_REJECTED/,
    '内部平台认证或权限未通过',
    '核对当前项目的内部 Token 和接口配置，回读原对象后恢复；不重新创建 Issue 或 PR。',
  ],
  [/RATE_LIMIT/, '平台读取额度受限', '等待平台允许后查询原任务。没有可靠限流窗口时不显示倒计时，不采用部分来源集合。'],
  [
    /RESULT_UNKNOWN|RESPONSE_AMBIGUOUS|LINK_UNKNOWN/,
    '平台写入结果尚未确认',
    '对象可能已经创建。先查询原候选、稳定标识和平台对象；找到后补登记原引用，不能再创建一份。',
  ],
  [
    /TASK_STORE|LEDGER_WRITE/,
    '业务动作与记录保存需要核对',
    '保留原任务；只补存执行记录，或回读原交付和 Git 结果。不要以重跑业务代替补存。',
  ],
  [
    /NOT_FORWARD|HISTORY_MISMATCH|NOT_MAIN_BOUNDARY|NOT_ON_SOURCE_BRANCH|TAG_MOVED/,
    '目标版本不满足接收条件',
    '核对历史起点、目标 SHA 与来源分支。已冻结轮次不能静默换终点；新选择应满足真实祖先和完整 PR 边界。',
  ],
  [
    /SOURCE_UNPROVEN|METADATA_INCOMPLETE|GITHUB_RESPONSE/,
    '来源信息尚未核对完整',
    '恢复失败的来源读取；无关联 PR 的提交会正常纳入，读取失败不能当成无 PR 继续。',
  ],
  [
    /COMMAND_NOT_FOUND/,
    '本机找不到执行工具',
    '确认运行正式服务的进程能找到 Git 和私有检查工具。拥有 Git 账号不等于该进程的 PATH 已正确配置；本插件不要求安装 gh。',
  ],
  [
    /UNAVAILABLE|TIMEOUT|CONNECTION|NETWORK/,
    '暂时无法确认远端结果',
    '检查当前失败通道的网络、证书或服务后回读原任务；已完成内容保留，不提交新的同步请求。',
  ],
];
export function guidance(error) {
  const [, title, next] = guides.find(([pattern]) => pattern.test(error.code ?? '')) ?? [
    null,
    '当前步骤尚未完成',
    '原因尚未确认。保留当前交付，核对具体失败步骤与安全详情，再恢复原操作。',
  ];
  return { title, next };
}
export function errorGuide(error, context = {}) {
  if (!error) return '';
  const { title, next } = guidance(error);
  const diagnostic = `错误码：${error.code ?? 'OPERATION_FAILED'}\n步骤：${context.stage ?? '当前步骤'}\n动作：${context.action ?? '未记录'}\n此摘要不含仓库地址、文件内容、Token 或原始日志。`;
  return `<section class="error-guide" role="alert"><h3>× ${title}</h3><p>${esc(error.message)}</p><p><b>接下来：</b>${next}</p>${repairButton(error, context)}<p>已创建对象与已接受版本保留；恢复按原对象核对。</p><details><summary>错误码与脱敏诊断摘要</summary><pre class="bounded-text" data-diagnostic-text>${esc(diagnostic)}</pre><button type="button" data-copy-diagnostic>复制摘要</button><span data-copy-result role="status"></span></details></section>`;
}
globalThis.document?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-diagnostic]');
  if (!button) return;
  const panel = button.closest('details');
  try {
    await navigator.clipboard.writeText(panel.querySelector('[data-diagnostic-text]').textContent);
    panel.querySelector('[data-copy-result]').textContent = '已复制，请预览后自行提交。';
  } catch {
    panel.querySelector('[data-copy-result]').textContent = '无法访问剪贴板，请选择上方文本复制。';
  }
});

export function failureSummary(snapshot) {
  const d = snapshot.state?.active,
    task = snapshot.operation,
    run = snapshot.state?.automation;
  const owns = !d || task?.deliveryId === d.id || task?.deliveryIds?.includes(d.id) || !task?.deliveryId;
  if (
    owns &&
    (task?.persistence?.status === 'FAILED' ||
      ['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(task?.status))
  )
    return null;
  const error =
    (owns && task?.status === 'FAILED' && task.error) || d?.error || (run?.status === 'FAILED' && run.error);
  if (!error) return null;
  const { title, next } = guidance(error);
  const repair = repairButton(error, { deliveryId: d?.id, primary: true });
  const objects = d?.prUrl
    ? '内部 PR 已登记，恢复将回读原 PR。'
    : 'PR 创建状态需按原意图回读确认；不会因本次报错重复创建。';
  return {
    code: error.code,
    repair,
    html: `<div class="failure-summary" role="alert"><b>× ${esc(title)}</b><p>${esc(error.message)}</p><small>${objects} ${esc(next)}</small></div>`,
  };
}
