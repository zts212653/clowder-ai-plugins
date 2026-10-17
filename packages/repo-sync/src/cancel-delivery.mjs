import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { gitlabPr } from './gitlab-pr.mjs';
import { event } from './store.mjs';

export function cancelDelivery(receiver, input) {
  if (input.confirmed !== true) fail('CANCEL_CONFIRMATION_REQUIRED', '请确认关闭旧 PR 并保留候选、Issue 和历史，然后撤销本笔。');
  return receiver.change(async (state) => {
    const d = receiver.active(state);
    if (!d || d.id !== input.deliveryId) fail('DELIVERY_CHANGED', '活动交付已变化，未关闭其他 PR。');
    if (input.previousUrl !== (d.prUrl ?? '')) fail('PR_MAPPING_CHANGED', '原 PR 链接已改变，请刷新核对再撤销。');
    if (d.acceptedInternal) fail('PR_ALREADY_MERGED', '本笔代码已接受，只能恢复核验，不能撤销或回退 main。');
    await assertUnmerged(receiver, d);
    const remote = await receiver.git.remoteBranch(d.branch);
    if (remote && remote !== d.candidate) fail('CANDIDATE_CONFLICT', '远端候选已改变，保留原交付，未关闭 PR。');
    const published = Boolean(remote || d.prUrl || d.prCreation || d.gitPr);
    if (published && receiver.config.pullRequests?.mode !== 'gitlab')
      fail('CANCEL_PLATFORM_UNSUPPORTED', '关闭已发布 PR 需要可查询关闭状态的平台 API；当前方式不能证明 PR 已关闭，原候选和历史保留。');
    d.cancellation ??= { status: 'REQUESTED', requestedAt: new Date().toISOString() };
    d.cancellation.status = 'REQUESTED';
    if (state.automation) {
      state.automation.status = 'PAUSED';
      state.automation.pauseRequested = { afterDeliveryId: d.id, requestedAt: d.cancellation.requestedAt };
      state.automation.updatedAt = new Date().toISOString();
    }
    await phase('cancel-intent', '保存原 PR 撤销意图并暂停轮次', () => receiver.store.save(state), false);
    let original = published ? await findOriginal(receiver, d) : null;
    if (original?.state === 'merged') {
      d.cancellation.status = 'MERGED';
      fail('PR_ALREADY_MERGED', '平台已合入此 PR，请先核验原合入结果，不能撤销。');
    }
    if (!original && (d.prCreation || d.prUrl || d.gitPr))
      fail('PR_CREATE_RESULT_UNKNOWN', '原 PR 创建结果尚未查到；不能假设未创建或安全撤销，先核对原对象。');
    if (original?.state === 'open') {
      await assertUnmerged(receiver, d);
      const id = /\/(\d+)$/.exec(original.url)?.[1];
      if (!id) fail('PR_OBJECT_MISMATCH', '原 PR 编号无效，未关闭。');
      await phase('cancel-pr', '关闭原内部 PR 并回读状态', async () => {
        await gitlabApi(receiver.config, receiver.config.pullRequests, 'PR').request(`merge_requests/${id}`, 'PUT', { state_event: 'close' });
        original = await findOriginal(receiver, d);
      }, false);
    }
    if (original && original.state !== 'closed') {
      if (original.state === 'merged') d.cancellation.status = 'MERGED';
      fail(original.state === 'merged' ? 'PR_ALREADY_MERGED' : 'PR_CLOSE_PENDING', '原 PR 关闭结果未确认；保留撤销意图，先回读原对象。');
    }
    await assertUnmerged(receiver, d);
    d.cancellation.status = 'COMPLETE';
    d.cancellation.completedAt = new Date().toISOString();
    d.status = 'CANCELLED';
    delete d.error;
    state.activeId = null;
    state.queue = [];
    if (state.automation) {
      state.automation.scanned = false;
      state.automation.restartOf = d.id;
      state.automation.autoMerge = false;
      if (['queue', 'latest'].includes(state.automation.selection.kind))
        state.automation.selection = { kind: 'commit', value: state.automation.target ?? d.target };
      state.automation.deliveryId = null;
      state.automation.pauseRequested = { afterDeliveryId: null, requestedAt: new Date().toISOString() };
      delete state.automation.error;
    }
    event(state, d, '原 PR 已关闭或确认尚未创建；本笔撤销，候选分支、Issue 和历史保留，接受游标未变化。明确继续后重新读取并准备。');
  });
}

async function assertUnmerged(receiver, d) {
  if ((await receiver.git.heads()).internal !== d.base.internal) {
    if (d.cancellation) d.cancellation.status = 'MERGED';
    fail('PR_ALREADY_MERGED', '内部 main 已前进，不能回退或撤销；先核验原交付实际合入结果。');
  }
}
async function findOriginal(receiver, d) {
  const found = await gitlabPr(receiver.config, 'find', {
    deliveryId: d.id, branch: d.branch, targetBranch: receiver.config.targetBranch,
  });
  if (!found) return null;
  if (found.head !== d.candidate || found.base !== d.base.internal ||
      (d.prUrl && found.url !== d.prUrl) || !['open', 'closed', 'merged'].includes(found.state))
    fail('PR_OBJECT_MISMATCH', '原 PR 的地址、候选或基线不匹配，未关闭任何其他对象。');
  return found;
}
