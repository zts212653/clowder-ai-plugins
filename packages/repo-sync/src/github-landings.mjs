import { fail } from './config.mjs';

export function groupLandings(boundaries, associations, branch) {
  const groups = [];
  for (const sha of boundaries) appendLanding(groups, sha, associations[sha], branch);
  for (const group of groups)
    if (group.pr && group.pr.merge_commit_sha !== group.target)
      fail('SOURCE_UNPROVEN', `PR 实际合入边界与提交 ${group.target.slice(0, 12)} 不符，不能搬运开发分支范围。`);
  return groups;
}

/**
 * 一个组只有在它吞进来的边界都属于该 PR 自己的提交时才算"一笔"。
 * squash merge 的 commits/{sha}/pulls 关联不稳定，可能把别的 landing 也挂到同一个 PR 上；
 * 那样中间的 landing 既不在队列里，又会让 PR 的父树下出现"未在内部基线证明"的变化，形成死锁。
 * 这里把不属于该 PR 提交清单的边界拆回逐笔交付。
 */
export function splitLandingsOutsidePr(group, ownedShas, associations, branch) {
  const owned = ownedShas instanceof Set ? ownedShas : new Set(ownedShas ?? []);
  const outside = group.boundaries.filter((sha) => !owned.has(sha));
  if (!outside.length) return [group];
  const kept = group.boundaries.filter((sha) => owned.has(sha));
  const groups = outside.map((sha) => landingForCommit(sha, associations[sha], branch));
  if (kept.length) groups.push({ ...group, boundaries: kept });
  return groups;
}

export function landingForCommit(sha, items, branch) {
  if (!Array.isArray(items) || !items.length) return { kind: 'commit', target: sha, boundaries: [sha] };
  const candidates = items.filter((pr) => pr.merged_at && pr.base?.ref === branch);
  const exact = candidates.find((pr) => pr.merge_commit_sha === sha);
  // 关联不稳定时宁可当作无 PR 主干提交，也不要把它并进另一个 PR 的范围。
  if (candidates.length !== 1 || !exact) return { kind: 'commit', target: sha, boundaries: [sha] };
  return { kind: 'pr', pr: exact, target: sha, boundaries: [sha] };
}
function appendLanding(groups, sha, items, branch) {
  if (!Array.isArray(items)) fail('METADATA_INCOMPLETE', '主干提交关联清单缺失，不能把读取失败当作无 PR。');
  if (!items.length) {
    groups.push({ kind: 'commit', target: sha, boundaries: [sha] });
    return;
  }
  const candidates = items.filter((pr) => pr.merged_at && pr.base?.ref === branch);
  if (candidates.length !== 1)
    fail(
      'SOURCE_UNPROVEN',
      `主干提交 ${sha.slice(0, 12)} 不能唯一归属来源分支已合入 PR（${candidates.length} 个匹配）。请核对关联；只有已确认无 PR 的提交才会自动纳入。`,
    );
  const pr = candidates[0],
    previous = groups.at(-1);
  if (typeof pr.node_id !== 'string' || !pr.node_id)
    fail('METADATA_INCOMPLETE', '来源 PR 缺少稳定身份，不能采用不完整关联。');
  if (previous?.pr?.node_id === pr.node_id) {
    previous.target = sha;
    previous.boundaries.push(sha);
  } else groups.push({ kind: 'pr', pr, target: sha, boundaries: [sha] });
}
