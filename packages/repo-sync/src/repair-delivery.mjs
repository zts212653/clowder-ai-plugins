import { createHash } from 'node:crypto';
import { commitPolicy } from './commit-policy.mjs';
import { closeCandidate } from './cancel-delivery.mjs';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { inspectCandidate, internalHead, pauseRecovery } from './exit-inspection.mjs';
import { confirmGitPr, planGitPr } from './git-pr.mjs';
import { associateIssues, settleIssues } from './issue-lifecycle.mjs';
import { preservedTree } from './preserved-tree.mjs';
import { git } from './process.mjs';
import { createPr, prUrl } from './pull-requests.mjs';
import { event } from './store.mjs';
import { assertProjection } from './trees.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rules = (receiver) => ({ internalPaths: receiver.config.internalPaths ?? [], mergePaths: [] });
const settings = (receiver) => digest([rules(receiver), commitPolicy(receiver.config)]);
function active(receiver, state) {
  const d = receiver.active(state);
  if (!d) fail('NO_ACTIVE_DELIVERY', '没有待修复的原交付。');
  pauseRecovery(state, d);
  return d;
}
export function previewRepair(receiver) {
  return receiver.change(async (state) => {
    const d = active(receiver, state);
    if (d.repair) fail('REPAIR_PENDING', '已有冻结的修复流程，请继续原修复，不另建 PR。');
    await receiver.store.save(state);
    const report = d.exitInspection = await inspectCandidate(receiver, d);
    if (report.kind !== 'MERGED' || !d.candidate || !await receiver.git.isAncestor(d.candidate, report.internal))
      fail('MERGE_UNATTRIBUTABLE', '尚未证明原候选已进入内部 main；不能构造修复 PR。请先检查原 PR 的实际合入方式。');
    // A repair must not silently overwrite valid core work added after the faulty merge.
    await assertProjection(receiver.git.directory, d.candidate, report.internal, rules(receiver), 'REPAIR_BASE_CHANGED');
    await receiver.git.checkContent(d.target);
    const tree = await preservedTree(receiver.git, d.target, report.internal, `${d.id}-repair`);
    const plan = { internal: report.internal, target: d.target, original: d.candidate, tree, attempt: d.repairHistory?.length ?? 0,
      settings: settings(receiver), changes: await git(receiver.git.directory, ['diff', '--name-status', report.internal, tree]) };
    const id = digest(plan);
    // Pin the preview tree to an owned commit so full migration includes it too.
    const previewCommit = await receiver.git.mergeNode(tree, [report.internal], `repo-sync repair preview ${id}`);
    await git(receiver.git.directory, ['update-ref', `refs/sync/repair-plans/${id}`, previewCommit]);
    d.repairPlan = { ...plan, id, previewCommit, createdAt: new Date().toISOString() };
    delete d.error;
  });
}
export function prepareRepair(receiver, input) {
  if (input.confirmed !== true) fail('REPAIR_CONFIRMATION_REQUIRED', '请核对差异，明确确认通过新 PR 修复。');
  return receiver.change(async (state) => {
    const d = active(receiver, state), plan = d.repairPlan;
    if (!plan || input.planId !== plan.id) fail('REPAIR_PLAN_CHANGED', '修复预览已变化，请重新核对后确认。');
    if (plan.settings !== settings(receiver)) fail('REPAIR_CONFIG_CHANGED', '保留路径或提交身份变化，请恢复原设置或重新预览；未覆盖原修复。');
    if (d.repair?.status === 'COMPLETE') return;
    if (!d.repair) {
      if ((await internalHead(receiver)) !== plan.internal) fail('REPAIR_BASE_CHANGED', 'main 已变化，请重新预览修复范围。');
      const id = digest([d.id, plan.id]).slice(0, 24);
      d.repair = { status: 'PREPARING', planId: plan.id, startedAt: new Date().toISOString(),
        delivery: { id, branch: `sync/repair-${id}`, target: d.target,
          base: { upstream: d.base.upstream, internal: plan.internal }, candidate: null,
          status: 'CODE_PREPARE_REQUIRED', source: d.source, issues: d.issues, commits: [],
          commitMappings: [], commitPolicy: { ...commitPolicy(receiver.config), strategy: 'rewrite' } } };
      await receiver.store.save(state);
    }
    const r = d.repair.delivery;
    if (r.cancellation?.status === 'REQUESTED') fail('CANCELLATION_PENDING', '修复 PR 的退出结果待回读，请先完成退出。');
    const main = await internalHead(receiver);
    if (r.candidate && await receiver.git.isAncestor(r.candidate, main))
      fail('REPAIR_ALREADY_MERGED', '修复候选已进入 main，请核验修复结果，不再发布。');
    if (main !== r.base.internal) fail('REPAIR_BASE_CHANGED', '修复准备期间 main 发生变化；保留候选，核对后再继续。');
    if (!r.candidate) {
      r.candidate = await phase('repair-build', '以 landing 文件树构造独立修复提交', () =>
        receiver.git.mergeNode(plan.tree, [r.base.internal], `repo-sync repair ${r.id} for ${d.id}`));
      await git(receiver.git.directory, ['update-ref', `refs/sync/deliveries/${r.id}`, r.candidate]);
      await receiver.store.save(state);
    }
    if (!r.checks?.passed) {
      r.checks = await phase('repair-check', '执行修复候选的项目检查', () => receiver.git.checks(r.candidate));
      await receiver.store.save(state);
    }
    const templates = { title: `修复同步 ${d.source.title ?? d.id}`, body:
      `原交付 ${d.id}\n原 PR ${d.prUrl ?? '未记录'}\n原 candidate ${d.candidate}\n上游 landing ${d.target}\n保留历史与 Issue，仅修复文件树。` };
    const options = receiver.config.pullRequests?.mode === 'git'
      ? await planGitPr(receiver, state, r, () => templates) : [];
    r.status = r.prUrl ? 'WAITING_APPROVAL' : 'PR_REQUIRED';
    d.repair.status = 'WAITING_REVIEW';
    await receiver.store.save(state);
    await phase('repair-publish', '发布独立修复分支（不覆盖原分支）', () => receiver.git.publish(r, options), false);
    if (receiver.config.pullRequests?.mode === 'git') await confirmGitPr(receiver, state, r);
    else if (receiver.config.pullRequests) await createPr(receiver, state, r, templates);
    await associateIssues(receiver, state, r);
    delete d.error;
    event(state, d, '修复候选已检查并发布；原候选与映射未修改。等待显式审核合入修复 PR。');
  });
}
export function linkRepair(receiver, input) {
  return receiver.change(async (state) => {
    const d = active(receiver, state), r = d.repair?.delivery;
    if (!r?.candidate || !r.checks?.passed) fail('PR_NOT_READY', '先构造并检查修复候选。');
    if (input.previousUrl !== (r.prUrl ?? '')) fail('PR_MAPPING_CHANGED', '修复 PR 地址已变化，请刷新。');
    if (input.confirmed !== true) fail('REPAIR_CONFIRMATION_REQUIRED', '请确认修复 PR 的源分支、目标分支和候选 SHA。');
    if ((await receiver.git.remoteBranch(r.branch)) !== r.candidate) fail('CANDIDATE_CONFLICT', '修复分支已改变。');
    const main = await internalHead(receiver);
    if (main !== r.base.internal && !await receiver.git.isAncestor(r.candidate, main))
      fail('REPAIR_BASE_CHANGED', 'main 已改变且尚不能归属原修复，先核对平台。');
    r.prUrl = prUrl(receiver.config, input.url);
    r.prReference = { verifiedBy: 'operator', time: new Date().toISOString() };
    r.status = 'WAITING_APPROVAL';
    await associateIssues(receiver, state, r);
    delete d.error;
  });
}
export function checkRepair(receiver) {
  return receiver.change(async (state) => {
    const d = active(receiver, state), repair = d.repair, r = repair?.delivery;
    if (!r?.candidate || !r.prUrl || !r.checks?.passed || r.checks.head !== r.candidate)
      fail('PR_NOT_READY', '修复候选、检查或 PR 地址尚未确认。');
    const main = await internalHead(receiver);
    if (main === r.base.internal) fail('REPAIR_NOT_MERGED', '修复 PR 尚未合入；请先在内部平台完成审核。');
    await phase('repair-verify', '核验修复 PR 实际合入树、祖先与原始历史', () => receiver.git.verify(r, main), false);
    r.acceptedInternal = main;
    r.status = 'COMPLETE';
    repair.status = 'COMPLETE';
    repair.completedAt = new Date().toISOString();
    repair.mappings = [{ source: d.target, internal: r.candidate }];
    // Retain the original candidate, base and all original per-commit mappings.
    d.acceptedInternal = main;
    state.accepted = { upstream: d.target, internal: main };
    d.status = d.mode === 'version' ? 'COMPLETE' : 'CODE_ACCEPTED_PENDING_METADATA';
    if (d.mode === 'version') {
      state.accepted.tag = d.source.tag;
      state.queue.shift();
    }
    if (d.cancellation?.status === 'REQUESTED') d.cancellation.status = 'MERGED';
    delete d.error;
    await receiver.store.save(state);
    await associateIssues(receiver, state, r);
    await settleIssues(receiver, state, d);
    event(state, d, '修复 PR 的实际结果已核验；保留原记录，保存修复对应并恢复原 Issue 接收流程。下一笔仍暂停，需明确继续。');
  });
}
export function retireRepair(receiver, input) {
  return receiver.change(async (state) => {
    const d = active(receiver, state), repair = d.repair;
    if (!repair || repair.status === 'COMPLETE') fail('REPAIR_NOT_READY', '没有可退出的未完成修复 PR。');
    if (input.planId !== repair.planId) fail('REPAIR_PLAN_CHANGED', '修复身份已变化，请刷新核对，未关闭其他对象。');
    await closeCandidate(receiver, state, repair.delivery, input);
    repair.status = 'CANCELLED'; repair.delivery.status = 'CANCELLED';
    d.repairHistory ??= [];
    d.repairHistory.push({ ...repair, plan: d.repairPlan });
    delete d.repair; delete d.repairPlan; delete d.error;
    pauseRecovery(state, d);
    event(state, d, '未合入的修复 PR 已退出；修复分支和历史保留。可基于当前 main 重新预览修复，原 Issue 不变。');
  });
}
