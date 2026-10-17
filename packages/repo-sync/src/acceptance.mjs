import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { event } from './store.mjs';
import { verifyTag } from './tags.mjs';

export async function recoverDelivery(receiver, state, delivery) {
  const heads = await receiver.git.fetch();
  if (receiver.config.mode === 'version') await verifyTag(receiver.git, delivery.frozenTag);
  else if (delivery.syncTarget?.frozenTag) await verifyTag(receiver.git, delivery.syncTarget.frozenTag);
  state.observedInternal = heads.internal;
  if (delivery.acceptedInternal) {
    if (heads.internal !== delivery.acceptedInternal)
      fail('ACCEPTED_HEAD_CONFLICT', '已接受代码之后 main 又改变，暂停核对');
    delivery.status = 'CODE_ACCEPTED_PENDING_METADATA';
    delete delivery.error;
    return;
  }
  if (heads.internal === delivery.base.internal) {
    await recoverCandidate(receiver.git, delivery);
    delete delivery.error;
    event(state, delivery, 'main 尚未接受本笔；原交付继续，未重复推送或建单');
    return;
  }
  if (
    !delivery.candidate ||
    !delivery.prUrl ||
    !delivery.checks?.passed ||
    delivery.checks.head !== delivery.candidate
  )
    fail('MERGE_UNATTRIBUTABLE', 'main 已前进，但没有完整冻结候选、检查和 PR 映射，暂停');
  if (await receiver.git.isAncestor(delivery.candidate, heads.internal)) {
    delivery.mergeObservation ??= {
      source: 'git',
      head: delivery.candidate,
      url: delivery.prUrl,
      observedAt: new Date().toISOString(),
    };
    await receiver.store.save(state);
  }
  await phase(
    'merge-verify',
    '核验实际合入的文件树与历史',
    () => receiver.git.verify(delivery, heads.internal),
    false,
  );
  delivery.acceptedInternal = heads.internal;
  state.accepted = { upstream: delivery.target, internal: heads.internal };
  if (receiver.config.mode === 'version') {
    state.accepted.tag = delivery.source.tag;
    delivery.status = 'COMPLETE';
    state.queue.shift();
    delete delivery.error;
    event(
      state,
      delivery,
      '版本候选的文件树与内部合入历史核验通过，已保存 tag 与两侧 commit 对应；无需 Issue 接收记录',
    );
    return;
  }
  delivery.status = 'CODE_ACCEPTED_PENDING_METADATA';
  delete delivery.error;
  event(state, delivery, '合入结果已归属原交付；tree、来源和内部历史核验通过，补写双游标');
}
async function recoverCandidate(git, delivery) {
  if (delivery.status !== 'PUSH_RESULT_UNKNOWN') return;
  const existing = await git.remoteBranch(delivery.branch);
  if (existing && existing !== delivery.candidate) fail('CANDIDATE_CONFLICT', '远端候选与冻结 head 冲突');
  delivery.status = existing
    ? 'PR_REQUIRED'
    : delivery.mode === 'version'
      ? 'CODE_PREPARE_REQUIRED'
      : 'ISSUES_REQUIRED';
}
