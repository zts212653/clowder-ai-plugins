import { fail } from './config.mjs';

export function groupLandings(boundaries, associations, branch) {
  const groups = [];
  for (const sha of boundaries) appendLanding(groups, sha, associations[sha], branch);
  for (const group of groups)
    if (group.pr && group.pr.merge_commit_sha !== group.target)
      fail('SOURCE_UNPROVEN', `PR 实际合入边界与提交 ${group.target.slice(0, 12)} 不符，不能搬运开发分支范围。`);
  return groups;
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
