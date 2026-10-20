import { buildCandidate, commitPolicy } from './commit-policy.mjs';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { confirmGitPr, planGitPr } from './git-pr.mjs';
import { associateIssues, ensureIssues } from './issue-lifecycle.mjs';
import { event } from './store.mjs';
import { sourceStillValid } from './version.mjs';
import { git } from './process.mjs';
import { verifyDevelopmentHistory } from './development-history.mjs';
import { assertProjection } from './trees.mjs';

async function resumePublished(receiver, state, delivery) {
  if (!['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status) || delivery.error) return false;
  if ((await receiver.git.remoteBranch(delivery.branch)) !== delivery.candidate)
    fail('CANDIDATE_CONFLICT', '已经推送的候选发生变化，暂停核对');
  if (delivery.status === 'WAITING_APPROVAL' || !receiver.config.pullRequests) {
    await associateIssues(receiver, state, delivery);
    return true;
  }
  if (receiver.config.pullRequests.mode === 'command') {
    await receiver.finishPr(state, delivery);
    return true;
  }
  if (!delivery.gitPr) return false;
  await confirmGitPr(receiver, state, delivery);
  await associateIssues(receiver, state, delivery);
  return true;
}
export async function prepareDelivery(receiver, state) {
  const delivery = receiver.requireActive(state);
  if (delivery.source.developmentReplay && !delivery.candidate) await verifyDevelopmentHistory(receiver, delivery);
  if (receiver.config.issues && delivery.status === 'ISSUES_REQUIRED' && !delivery.candidate)
    await ensureIssues(receiver, state, delivery);
  if (delivery.commitPolicy && JSON.stringify(delivery.commitPolicy) !== JSON.stringify(commitPolicy(receiver.config)))
    fail('COMMIT_POLICY_CHANGED', '请恢复本笔交付冻结的提交身份配置后继续。');
  receiver.requirePreparation(state, delivery);
  if (delivery.candidate) await verifyReplayCandidate(receiver, delivery);
  if (await resumePublished(receiver, state, delivery)) return;
  const heads = await receiver.git.fetch();
  state.observedInternal = heads.internal;
  if (heads.internal !== delivery.base.internal) fail('RECOVERY_FIRST', 'main 已前进，先核对原交付合入结果');
  await sourceStillValid(receiver, delivery, heads);
  if (!delivery.candidate) {
    const result = await phase('candidate-build', '构造同步候选与内外 SHA 映射', () =>
      buildCandidate(receiver, state, delivery),
    );
    delivery.candidate = result.head;
    if (result.mappings) delivery.commitMappings = result.mappings;
    if (result.developmentMappings) delivery.developmentMappings = result.developmentMappings;
    delivery.internalCommitCount = Number(await git(receiver.git.directory, ['rev-list', '--count', result.head, `^${delivery.base.internal}`]));
  }
  await verifyReplayCandidate(receiver, delivery);
  await receiver.store.save(state);
  delivery.checks = await phase(
    'candidate-check',
    receiver.config.checkProfile === 'git-integrity' ? 'Git 基础完整性检查' : '执行配置的项目检查',
    () => receiver.git.checks(delivery.candidate),
  );
  const checkedHeads = await receiver.git.fetch();
  if (checkedHeads.internal !== delivery.base.internal)
    fail('RECOVERY_FIRST', '检查期间内部 main 已改变，先核对原交付');
  await sourceStillValid(receiver, delivery, checkedHeads);
  await publishCandidate(receiver, state, delivery);
}
async function verifyReplayCandidate(receiver, delivery) {
  if (!delivery.source.developmentReplay) return;
  try {
    await assertProjection(receiver.git.directory, delivery.target, delivery.candidate,
      { internalPaths: receiver.config.internalPaths ?? [], mergePaths: [] }, 'CANDIDATE_TREE_MISMATCH');
  } catch (error) {
    if (error.code !== 'CANDIDATE_TREE_MISMATCH') throw error;
    fail(error.code, '冻结候选与上游实际 landing 内容不同，已停止发布。请放弃未合入的本笔后重新同步；原候选、映射与历史保留，不覆盖分支。', error.details);
  }
}
async function publishCandidate(receiver, state, delivery) {
  const gitCreation = receiver.config.pullRequests?.mode === 'git';
  const options = gitCreation
    ? await planGitPr(receiver, state, delivery, () => receiver.deliveryTemplates(state, delivery))
    : [];
  delivery.status = 'PUSH_RESULT_UNKNOWN';
  event(state, delivery, '候选推送意图已保存；结果不明时先读取同名 ref');
  await phase('publish-intent', '保存候选与 PR 发布意图', () => receiver.store.save(state), false);
  await phase(
    'candidate-publish',
    gitCreation ? '推送候选并触发内部 PR 创建' : '推送并回读候选分支',
    () => receiver.git.publish(delivery, options),
    false,
  );
  delivery.status = 'PR_REQUIRED';
  delete delivery.error;
  event(state, delivery, '候选分支已推送并回读；内部 main 未修改，开始处理 PR 创建');
  if (receiver.config.pullRequests) await receiver.finishPr(state, delivery);
}
