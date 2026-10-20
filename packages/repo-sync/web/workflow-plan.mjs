// Shared by the runtime event recorder and browser; no environment-specific imports.
export const workflowPlanVersion = 2;
export function phaseStage(key) {
  if (key.startsWith('repair-')) return 5;
  for (let stage = 1; stage <= 5; stage++)
    if (plannedSteps(stage, false).some(([id]) => id === key)) return stage;
  if (['merge-policy', 'merge-intent', 'platform-merge', 'merge-observe'].includes(key)) return 4;
}
export function plannedSteps(stage, version) {
  return (
    {
      1: [
        ['source-probe', '检查外部连接与分支'],
        ['internal-probe', '检查内部连接与分支'],
        ['object-store', '准备私有对象目录'],
        ['source-fetch', '下载外部对象'],
        ['internal-fetch', '下载内部对象'],
        ['source-read', '核对两侧仓库读取结果'],
        ['target-check', '核对目标、起点与历史范围'],
        ...(!version ? [['github-deliveries', '核对 PR、直接提交与 Issue 来源']] : []),
        ['delivery-start', '冻结本笔交付并登记台账'],
      ],
      2: [
        ...(!version ? [['issue-create', '创建 / 复用并回读内部 Issue']] : []),
        ['candidate-build', '准备提交映射并保留内部文件'],
        ['candidate-check', '执行配置的候选检查'],
      ],
      3: [
        ['publish-intent', '保存原发布意图'],
        ['candidate-publish', '推送原候选分支'],
        ['candidate-ref', '回读候选 ref'],
        ['platform-pr', '创建 / 回读原内部 PR'],
        ...(!version ? [['issue-link', '关联并回读内部 Issue 与 PR']] : []),
      ],
      4: [
        ['merge-readiness', '核对 CI 与平台合入条件'],
        ['platform-review', '等待人工审核（如需）'],
        ['platform-merge', '请求平台自动合入（如启用）'],
        ['merge-observe', '确认原 PR 合入结果'],
      ],
      5: [
        ['merge-verify', '核验实际合入的核心文件与历史'],
        ...(!version ? [['issue-state', '核对接收条件、更新应关闭的 Issue 并回读']] : []),
        ['acceptance-save', '保存本笔接收结果'],
        ['execution-record', '保存原执行记录'],
      ],
    }[stage] ?? []
  );
}
export function businessStep(stage, key, plan, parentKey) {
  if (plan.has(key)) return key;
  if (plan.has(parentKey)) return parentKey;
  if (stage === 1) return /ledger|delivery-start/.test(key) ? 'delivery-start' : 'source-read';
  if (stage === 2)
    return key.startsWith('issue-') && plan.has('issue-create') ? 'issue-create' : 'candidate-build';
  if (stage === 3) return /probe|fetch|candidate-ref/.test(key) ? 'candidate-ref' : 'platform-pr';
  if (stage === 4) return key === 'merge-intent' ? 'platform-merge' : 'merge-observe';
  if (/execution-record/.test(key)) return 'execution-record';
  if (key.startsWith('issue-') && plan.has('issue-state')) return 'issue-state';
  if (/receipts-save|acceptance-save/.test(key)) return 'acceptance-save';
  return 'merge-verify';
}
