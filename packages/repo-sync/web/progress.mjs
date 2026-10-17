export function progressSteps(delivery, state, checkProfile, prMode = 'manual') {
  const status = delivery.status;
  const pushed = ['PR_REQUIRED', 'WAITING_APPROVAL', 'CODE_ACCEPTED_PENDING_METADATA', 'COMPLETE'].includes(status);
  const complete = status === 'COMPLETE';
  const version = delivery.mode === 'version';
  const nodes = [
    [
      '准备同步',
      [
        ['冻结范围与基线', true],
        [
          version ? '核对文件规则与内部差异' : '登记内部 Issue 映射',
          version || delivery.issues.every((issue) => state.issues[issue.sourceId]),
        ],
        [version ? '保留内部文件并构造候选' : '构造原始对象候选', Boolean(delivery.candidate)],
        [
          checkProfile === 'git-integrity' || delivery.checks?.profile === 'git-integrity'
            ? 'Git 基础完整性检查'
            : '配置的项目检查',
          delivery.checks?.passed === true,
        ],
        ['推送并回读候选分支', pushed],
      ],
    ],
    [
      '创建 / 登记内部 PR',
      [[prMode === 'automatic' ? '查询/创建并回读内部 PR' : '在平台创建并登记 PR 地址', Boolean(delivery.prUrl)]],
    ],
    ['审核并合入', [['在平台正常审核合入', Boolean(delivery.acceptedInternal)]]],
    [
      '核验与接收记录',
      [
        ['核验 main 的 tree 与历史', Boolean(delivery.acceptedInternal)],
        [version ? '保存 tag 与内外 commit 对应' : '保存本笔 Issue 接收记录', complete],
      ],
    ],
    ['完成', [['记录结果并开放下一笔', complete]]],
  ];
  const codeError = ['TREE_MISMATCH', 'HISTORY_REWRITTEN', 'MERGE_BASE_HEAD_MISMATCH', 'MERGE_UNATTRIBUTABLE'].includes(
    delivery.error?.code,
  );
  let currentFound = false;
  return nodes.map(([label, steps]) => ({
    label,
    children: steps.map(([name, done]) => {
      let status = done ? 'done' : currentFound ? 'pending' : 'current';
      if (!done) currentFound = true;
      status = errorStatus(name, status, delivery.error, codeError);
      return { name, status };
    }),
  }));
}
function errorStatus(name, status, error, codeError) {
  if (codeError && name === '核验 main 的 tree 与历史') return 'failed';
  if (status === 'current' && error && !codeError) return 'failed';
  return status;
}
