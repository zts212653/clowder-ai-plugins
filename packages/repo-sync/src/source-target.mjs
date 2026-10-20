import { fail } from './config.mjs';
import { freezeTag } from './tags.mjs';

export async function sourceTarget(receiver, state, heads, selection) {
  const kind = selection?.kind ?? 'latest';
  let commit = heads.upstream;
  let frozenTag;
  if (kind === 'tag') {
    frozenTag = await freezeTag(receiver.git, selection.value);
    commit = frozenTag.commit;
  } else if (kind === 'commit') {
    if (!/^[a-f0-9]{40}$/.test(selection.value ?? '')) fail('INVALID_TARGET', '请填写完整的目标 commit SHA');
    commit = await receiver.git.sha(selection.value);
  } else if (kind !== 'latest') fail('INVALID_TARGET', '目标需要 latest、tag 或 commit');
  if (!(await receiver.git.isAncestor(state.accepted.upstream, commit)))
    fail(
      'TARGET_NOT_FORWARD',
      `目标 ${commit.slice(0, 12)} 不包含已接收版本 ${state.accepted.upstream.slice(0, 12)}，可能是回退或分叉。请选择包含已接收历史的目标；不会修改基线或内部仓库。`,
    );
  if (!(await receiver.git.isAncestor(commit, heads.upstream)))
    fail(
      'TARGET_NOT_ON_SOURCE_BRANCH',
      `目标 ${commit.slice(0, 12)} 已在接收基线之后，但不在来源分支 ${receiver.config.sourceBranch}（${heads.upstream.slice(0, 12)}）的历史中。发布 tag 可能在独立发布分支；同步开发过程需选择来源分支实际合入后的目标。若只接收该 tag 的版本内容，请新增项目选择“按版本更新”；原项目记录保留。`,
    );
  if (!(await receiver.git.mainBoundary(commit, heads.upstream)))
    fail(
      'TARGET_NOT_MAIN_BOUNDARY',
      '目标在来源历史中，但不是来源分支的实际合入边界，不能截断一个 PR。请选择 PR 合入后的提交或标签。',
    );
  return {
    kind,
    value: kind === 'latest' ? 'latest' : selection.value,
    commit,
    ...(selection?.includeDirectCommits === true ? { includeDirectCommits: true } : {}),
    ...(frozenTag ? { frozenTag } : {}),
    selectedAt: new Date().toISOString(),
  };
}
