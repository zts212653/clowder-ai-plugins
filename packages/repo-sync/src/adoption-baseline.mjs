import { fail } from './config.mjs';
import { configurationErrors } from './configuration-errors.mjs';
import { assertProjection } from './trees.mjs';
import { versionBaseline } from './version.mjs';

export async function adoptionBaseline(receiver, upstream, internal, heads) {
  internal = await receiver.git.sha(internal);
  if (heads.internal !== internal) configurationErrors([['internal', 'head']], 'STALE_INTERNAL_HEAD');
  if (receiver.config.mode === 'version') {
    upstream = await versionBaseline(receiver, upstream, heads);
    await receiver.git.baseline(upstream, internal);
  } else {
    upstream = await receiver.git.sha(upstream);
    await processBaseline(receiver, upstream, internal, heads);
  }
  return { upstream, internal };
}
async function processBaseline(receiver, upstream, internal, heads) {
  if (!(await receiver.git.isAncestor(upstream, heads.upstream)))
    fail('BASELINE_HISTORY_MISMATCH', 'U0 不在外部交付分支历史中，请重新选择上次已同步版本；未登记基线');
  await assertProjection(
    receiver.git.directory,
    upstream,
    internal,
    { internalPaths: receiver.config.internalPaths ?? [], mergePaths: [] },
    'BASELINE_MISMATCH',
  );
  if (!(await receiver.git.mainBoundary(upstream, heads.upstream)))
    fail('BASELINE_NOT_MAIN_BOUNDARY', '基线必须是上游来源分支的实际接受边界');
}
