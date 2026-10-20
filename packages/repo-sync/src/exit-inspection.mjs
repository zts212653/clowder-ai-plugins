import { createHash } from 'node:crypto';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { gitlabPr } from './gitlab-pr.mjs';
import { git } from './process.mjs';
import { prUrl } from './pull-requests.mjs';

export function pauseRecovery(state, d) {
  if (!state.automation) return;
  Object.assign(state.automation, { status: 'PAUSED', autoMerge: false,
    pauseRequested: { afterDeliveryId: d.id, requestedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString() });
}
export async function internalHead(receiver) {
  await receiver.git.ready();
  const c = receiver.config;
  await phase('exit-inspect', '只读取内部 main 与原候选，不校验旧候选内容', () => git(receiver.git.directory,
    ['fetch', '--no-tags', c.internalUrl, `+refs/heads/${c.targetBranch}:refs/sync/internal`],
    { timeout: c.timeouts?.fetch ?? 600000 }));
  return receiver.git.sha('refs/sync/internal');
}
export async function originalPr(receiver, d) {
  if (receiver.config.pullRequests?.mode !== 'gitlab') return undefined;
  let found;
  if (d.prUrl) {
    const url = prUrl(receiver.config, d.prUrl);
    const id = /\/(\d+)$/.exec(url)?.[1];
    if (!id) fail('PR_OBJECT_MISMATCH', '原 PR 编号无效，未关闭任何对象。');
    const item = await gitlabApi(receiver.config, receiver.config.pullRequests, 'PR').request(`merge_requests/${id}`);
    if (d.prCreation && !item?.description?.includes(`[repo-sync-pr:${d.id}]`))
      fail('PR_OBJECT_MISMATCH', '原 PR 来源标识不匹配，未关闭任何对象。');
    found = item && { branch: item.source_branch, targetBranch: item.target_branch,
      head: item.sha, state: item.state === 'opened' ? 'open' : item.state, url: item.web_url };
  } else found = await gitlabPr(receiver.config, 'find', {
    deliveryId: d.id, branch: d.branch, targetBranch: receiver.config.targetBranch,
  });
  // diff_refs.base_sha can legitimately change when unrelated work advances main.
  if (found && (found.head !== d.candidate || found.branch !== d.branch ||
      found.targetBranch !== receiver.config.targetBranch ||
      (d.prUrl && found.url !== d.prUrl) || !['open', 'closed', 'merged'].includes(found.state)))
    fail('PR_OBJECT_MISMATCH', '原 PR 的仓库、分支、候选或状态不匹配；未操作其他对象。');
  if (found) prUrl(receiver.config, found.url);
  return found;
}
export async function inspectCandidate(receiver, d) {
  const internal = await internalHead(receiver);
  const remote = await receiver.git.remoteBranch(d.branch);
  if (remote && remote !== d.candidate) fail('CANDIDATE_CONFLICT', '原候选分支已变化，保留对象，未关闭任何 PR。');
  const containsCandidate = d.candidate && await receiver.git.isAncestor(d.candidate, internal);
  const merged = d.acceptedInternal || containsCandidate;
  if (containsCandidate && d.prUrl) d.mergeObservation ??= {
    source: 'git', head: d.candidate, url: d.prUrl, observedAt: new Date().toISOString(),
  };
  const published = Boolean(remote || d.prUrl || d.prCreation || d.gitPr);
  const pr = published && !merged ? await originalPr(receiver, d) : null;
  const kind = merged || pr?.state === 'merged' ? 'MERGED'
    : !published ? 'LOCAL_ONLY' : pr?.state === 'open' ? 'OPEN_PR'
    : pr?.state === 'closed' ? 'CLOSED_PR' : pr === undefined ? 'MANUAL_REQUIRED'
    : d.prUrl || d.prCreation || d.gitPr ? 'UNKNOWN' : 'BRANCH_ONLY';
  const facts = { deliveryId: d.id, candidate: d.candidate, branch: d.branch, internal,
    remote, kind, pr: pr ?? null, previousUrl: d.prUrl ?? '' };
  return { ...facts, id: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    observedAt: new Date().toISOString() };
}
export function inspectExit(receiver, repair = false) {
  return receiver.change(async (state) => {
    const d = receiver.active(state);
    if (!d) fail('NO_ACTIVE_DELIVERY', '没有待退出的同步。');
    pauseRecovery(state, d);
    await receiver.store.save(state);
    const candidate = repair ? d.repair?.delivery : d;
    if (!candidate) fail('REPAIR_NOT_READY', '没有待退出的修复候选。');
    candidate.exitInspection = await inspectCandidate(receiver, candidate);
    delete d.error;
  });
}
