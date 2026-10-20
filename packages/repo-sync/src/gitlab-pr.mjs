import { fail } from './config.mjs';
import { gitlabApi } from './gitlab-api.mjs';

const marker = (r) => `[repo-sync-pr:${r.deliveryId}]`;
export async function gitlabPr(config, action, r) {
  const api = gitlabApi(config, config.pullRequests, 'PR');
  if (action === 'create') {
    await api.request('merge_requests', 'POST', {
      source_branch: r.branch,
      target_branch: r.targetBranch,
      title: r.title,
      description: `${r.body ?? ''}\n\n${marker(r)}`,
    });
    return null;
  }
  const matches = await api.list(
    `merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(r.branch)}&target_branch=${encodeURIComponent(r.targetBranch)}`,
  );
  if (
    matches.some(
      (item) =>
        item.source_branch !== r.branch ||
        item.target_branch !== r.targetBranch ||
        !item.description?.includes(marker(r)),
    ) ||
    matches.length > 1
  )
    fail('PR_OBJECT_MISMATCH', '同一候选分支存在重复或来源不匹配的 MR，未创建第二个对象；请核对原交付。');
  if (!matches.length) return null;
  const id = matches[0].iid;
  if (!Number.isSafeInteger(id) || id < 1) fail('PR_OBJECT_MISMATCH', '平台 MR 回执编号无效，未采用。');
  const item = await api.request(`merge_requests/${id}`);
  if (!item?.description?.includes(marker(r))) fail('PR_OBJECT_MISMATCH', '平台 MR 缺少原交付的稳定来源标识，未采用。');
  return {
    deliveryId: r.deliveryId,
    branch: item.source_branch,
    targetBranch: item.target_branch,
    head: item.sha,
    base: item.diff_refs?.base_sha,
    state: item.state === 'opened' ? 'open' : item.state,
    url: item.web_url,
  };
}
