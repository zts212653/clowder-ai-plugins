import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { matches } from './policy.mjs';
import { git } from './process.mjs';
import { entries, equalEntry } from './trees.mjs';

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export async function developmentHistory(receiver, provider, repo, pr, introduced, base) {
  if (pr.commits === undefined) return {}; // Older injected providers do not claim a complete development list.
  if (!Number.isSafeInteger(pr.commits) || pr.commits < 1)
    fail('PR_HISTORY_INCOMPLETE', 'PR 开发提交数量无效，无法确认完整历史。');
  const summary = { developmentCommitCount: pr.commits };
  if (receiver.config.commitStrategy !== 'rewrite' || introduced.length !== 1 || pr.commits === 1) return summary;
  if (!sha(pr.head?.sha) || !Number.isSafeInteger(pr.number) || pr.number < 1)
    fail('PR_HISTORY_INCOMPLETE', '展开 squash PR 需要明确的 PR 编号和冻结 head。');
  const items = await provider.api(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`, true);
  if (!Array.isArray(items) || items.length !== pr.commits || items.some((item) => !sha(item?.sha)) ||
      new Set(items.map((item) => item.sha)).size !== items.length || !items.some((item) => item.sha === pr.head.sha))
    fail('PR_HISTORY_INCOMPLETE', 'PR 开发提交清单缺失、重复或被平台截断；未创建 Issue / PR，请核对来源读取权限和完整清单。');
  const replay = { schema: 1, head: pr.head.sha, commits: items.map((item) => item.sha), landingBase: base, landing: pr.merge_commit_sha };
  await verifyDevelopmentHistory(receiver, { source: { number: pr.number, developmentReplay: replay }, base: { upstream: base }, target: pr.merge_commit_sha });
  return { ...summary, developmentReplay: replay };
}

export function validateDevelopmentReplay(replay) {
  if (!replay || replay.schema !== 1 || !sha(replay.head) || !sha(replay.landingBase) || !sha(replay.landing) ||
      !Array.isArray(replay.commits) || replay.commits.length < 2 || replay.commits.some((item) => !sha(item)) ||
      new Set(replay.commits).size !== replay.commits.length || !replay.commits.includes(replay.head))
    fail('PR_HISTORY_INCOMPLETE', '冻结的 PR 开发历史损坏；保留原记录，不退回压缩提交。');
}

export async function verifyDevelopmentHistory(receiver, delivery) {
  const replay = delivery.source.developmentReplay;
  validateDevelopmentReplay(replay);
  if (replay.landingBase !== delivery.base.upstream || replay.landing !== delivery.target ||
      !Number.isSafeInteger(delivery.source.number) || delivery.source.number < 1)
    fail('PR_HISTORY_CHANGED', '开发历史与本笔 main 接受范围不匹配，未重放或发布。');
  const ref = `refs/sync/pr/${delivery.source.number}`;
  await phase('pr-history', '读取并核对原 PR 的完整开发提交', async () => {
    try {
      await git(receiver.git.directory, ['fetch', '--no-tags', receiver.git.config.sourceUrl,
        `+refs/pull/${delivery.source.number}/head:${ref}`]);
    } catch {
      fail('PR_HISTORY_UNAVAILABLE', '无法读取原 PR 的 Git 对象；检查外部仓库读取权限和 PR ref 后恢复，不退回单条提交。');
    }
    if (await receiver.git.sha(ref) !== replay.head)
      fail('PR_HISTORY_CHANGED', '原 PR head 与冻结清单不一致；请核对上游变化，未发布候选。');
  });
  const output = await git(receiver.git.directory, ['rev-list', '--reverse', '--topo-order', replay.head, `^${replay.landingBase}`]);
  const sources = output ? output.split('\n') : [];
  if (sources.length !== replay.commits.length || sources.some((item) => !replay.commits.includes(item)) || sources.at(-1) !== replay.head)
    fail('PR_HISTORY_INCOMPLETE', 'PR API 清单与实际 Git 范围不一致；不能重复搬运已接受的主干提交或漏掉开发提交。');
  await assertReplayProjection(receiver, delivery, replay);
  return sources;
}

async function changedPaths(directory, before, after) {
  const output = await git(directory, ['diff', '--no-renames', '--name-only', '-z', before, after]);
  return new Set(output.split('\0').filter(Boolean));
}

export async function assertReplayProjection(receiver, delivery, replay) {
  const directory = receiver.git.directory;
  const parents = (await git(directory, ['show', '-s', '--format=%P', replay.landing])).split(' ').filter(Boolean);
  const landingParent = parents[0];
  if (!landingParent) fail('PR_REPLAY_TREE_MISMATCH', 'PR landing commit 缺少可核对的 main 父提交；未发布候选。');
  const internal = delivery.base.internal ?? (await receiver.git.sha('refs/sync/internal'));
  const [headTree, landingTree, parentTree, internalTree] = await Promise.all([
    entries(directory, replay.head),
    entries(directory, replay.landing),
    entries(directory, landingParent),
    entries(directory, internal),
  ]);
  const [sourceChanges, parentChanges, landingChanges] = await Promise.all([
    changedPaths(directory, replay.landingBase, replay.head),
    changedPaths(directory, replay.landingBase, landingParent),
    changedPaths(directory, landingParent, replay.landing),
  ]);
  const preserved = (path) => (receiver.config.internalPaths ?? []).some((rule) => matches(path, rule));
  const mismatches = [];
  for (const path of sourceChanges) {
    // landing 相对其父提交没有变化 => 这个差异继承自并行 main，不是本 PR 改的，
    // 交给 check #2（parentChanges vs internal 基线）去要求先接收，不在这里阻塞。
    if (
      !preserved(path) &&
      !equalEntry(headTree.get(path), landingTree.get(path)) &&
      !equalEntry(landingTree.get(path), parentTree.get(path))
    )
      mismatches.push(path);
  }
  for (const path of parentChanges) {
    if (!sourceChanges.has(path) && !preserved(path) && !equalEntry(parentTree.get(path), internalTree.get(path))) mismatches.push(path);
  }
  for (const path of landingChanges) {
    if (!sourceChanges.has(path) && !preserved(path) && !equalEntry(landingTree.get(path), internalTree.get(path))) mismatches.push(path);
  }
  if (mismatches.length)
    fail('PR_REPLAY_TREE_MISMATCH', 'PR landing 包含未在 PR head 或内部基线中证明的核心文件变化；请先接收并行 main 提交或核对冲突处理。', {
      paths: [...new Set(mismatches)],
      upstream: replay.landing,
      internal,
    });
}
