export function baselineFingerprint(binding) {
  return JSON.stringify([
    binding.externalUrl,
    binding.sourceBranch,
    binding.internalUrl,
    binding.targetBranch,
    binding.mode,
    binding.baseline.toLowerCase(),
    binding.internalBaseline?.toLowerCase(),
  ]);
}
export function simulateBaselineCheck(binding, outcome = 'match') {
  return {
    simulated: true,
    fingerprint: baselineFingerprint(binding),
    sourceSha: binding.baseline.toLowerCase(),
    internalSha: binding.internalBaseline.toLowerCase(),
    checks: [
      { id: 'source-branch', label: '外部 commit A 位于指定交付分支的历史中', passed: true },
      { id: 'internal-head', label: '内部 commit B 是当前合入分支的 HEAD', passed: outcome !== 'head-moved' },
      { id: 'same-tree', label: 'A 与 B 的核心文件树一致', passed: outcome !== 'tree-mismatch' },
    ],
  };
}
export function assertBaselineCheck(binding, check) {
  if (
    !check?.simulated ||
    check.fingerprint !== baselineFingerprint(binding) ||
    check.sourceSha !== binding.baseline.toLowerCase() ||
    check.internalSha !== binding.internalBaseline.toLowerCase()
  )
    throw new Error('基线对应尚未核验或已修改，请重新检查。');
  if (
    !['source-branch', 'internal-head', 'same-tree'].every((id) =>
      check.checks?.some((item) => item.id === id && item.passed === true),
    )
  )
    throw new Error('基线核验失败：核对两侧核心文件树与内部分支当前版本后再接管。');
}
export function existingRepositoryDeliveries() {
  const titles = ['整理通用能力接口', '完善插件配置校验', '增加通用运行状态观测', '补齐能力文档与检查'];
  return titles.map((title, index) => {
    const commits = Array.from(
      { length: 5 },
      (_, offset) => `b1${(index * 5 + offset + 1).toString(16).padStart(6, '0')}`,
    );
    return {
      id: `delivery-06${index + 1}`,
      target: commits.at(-1),
      sourcePr: 101 + index,
      internalPr: 201 + index,
      issue: 91 + index,
      internalIssue: 401 + index,
      issueRelation: 'closes',
      autoCloseIssue: true,
      title,
      commits,
      mode: 'Merge',
      files: 5 + index,
      time: `12:${index}0`,
    };
  });
}
