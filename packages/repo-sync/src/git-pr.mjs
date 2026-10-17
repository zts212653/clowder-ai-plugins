import { createHash } from 'node:crypto';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { prUrl } from './pull-requests.mjs';
import { event } from './store.mjs';

export const defaultPushOptions = [
  'merge_request.create',
  'merge_request.target={targetBranch}',
  'merge_request.title={title}',
  'merge_request.description={description}',
];
export function validateGitPr(config) {
  const options = config.pullRequests.pushOptions ?? defaultPushOptions;
  if (!config.internalWebUrl || !Array.isArray(options) || !options.length || options.length > 12)
    fail('INVALID_GIT_PR', 'Git 自动创建需要内部网页仓库地址和 1～12 项创建选项');
  for (const option of options) {
    if (
      typeof option !== 'string' ||
      /[\r\n\0]/.test(option) ||
      /auto_merge|merge_when_pipeline_succeeds|remove_source_branch|ci\.skip|integrations\.skip_ci|target_project/i.test(
        option,
      ) ||
      [...option.matchAll(/\{([^}]+)\}/g)].some(
        (match) => !['targetBranch', 'title', 'description', 'deliveryId'].includes(match[1]),
      )
    )
      fail('INVALID_GIT_PR', 'Git 创建选项不可含自动合入、删除分支、跳过检查、控制字符或未知占位符');
  }
}
export function pushOptions(config, delivery, templates) {
  const values = {
    targetBranch: config.targetBranch,
    title: templates.title,
    description: templates.body.replaceAll('\\', '\\\\').replace(/\r?\n/g, '\\n'),
    deliveryId: delivery.id,
  };
  const options = (config.pullRequests.pushOptions ?? defaultPushOptions).map((option) =>
    option.replace(/\{([^}]+)\}/g, (_, name) => values[name]),
  );
  if (options.some((option) => /[\r\n\0]/.test(option) || Buffer.byteLength(option) > 60000))
    fail('GIT_PR_OPTIONS_TOO_LARGE', '创建选项包含控制字符或超过 Git 传输大小限制；请减少 PR 正文，候选尚未推送');
  return options;
}
export async function planGitPr(receiver, state, delivery, templates) {
  const calculate = () => {
    const options = pushOptions(receiver.config, delivery, templates());
    return {
      options,
      fingerprint: createHash('sha256')
        .update(JSON.stringify([receiver.config.internalWebUrl, options]))
        .digest('hex'),
    };
  };
  if (delivery.gitPr) {
    const { options, fingerprint } = calculate();
    if (delivery.gitPr.fingerprint !== fingerprint)
      fail('GIT_PR_CONFIG_CHANGED', '已冻结的 Git PR 创建选项改变，请恢复原配置，不能重复创建');
    return options;
  }
  if (delivery.prUrl) fail('PR_MAPPING_CONFLICT', '已有 PR 引用，不能另建 Git PR；请先核对该引用');
  const previous = await receiver.git.remoteBranch(delivery.branch);
  if (previous) {
    if (previous !== delivery.candidate) fail('CANDIDATE_CONFLICT', '原候选已变化，不能创建 PR');
    const original = delivery.branch;
    delivery.branch = `${original}-pr`;
    if (await receiver.git.remoteBranch(delivery.branch)) {
      delivery.branch = original;
      fail('GIT_PR_BRANCH_EXISTS', '专用 PR 分支已存在但没有创建回执；请核对原流程，不能重复推送');
    }
    delivery.branchHistory ??= [];
    delivery.branchHistory.push({ branch: original, reason: 'git-pr-intake', time: new Date().toISOString() });
    event(state, delivery, '原候选已发布；保留旧分支，以同一已检查 commit 发布专用 PR 分支，不修改提交或 main');
  }
  const { options, fingerprint } = calculate();
  delivery.gitPr = { fingerprint, branch: delivery.branch, status: 'INTENT_SAVED' };
  return options;
}
export function captureGitPr(config, delivery, output) {
  if (output.truncated) fail('GIT_PR_LINK_UNKNOWN', '平台输出过多，无法完整确认 PR 回执；保留原交付，不重新创建');
  const matches = [
    ...`${output.stdout}\n${output.stderr}`
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .matchAll(/https:\/\/[^\s<>"']+\/(?:-\/)?(?:merge_requests|pull|pulls|pull-requests)\/\d+\b/g),
  ];
  const urls = [...new Set(matches.map((match) => match[0]))];
  if (urls.length > 1) fail('GIT_PR_RESPONSE_AMBIGUOUS', '平台返回多个 PR 地址，暂停核对原交付，不选择其中任意一个');
  if (urls.length === 1) delivery.gitPr.url = prUrl(config, urls[0]);
}
export async function confirmGitPr(receiver, state, delivery) {
  return phase(
    'platform-pr',
    '核验 Git 创建回执与候选分支',
    async () => {
      if (delivery.prReference?.withdrawn)
        fail('PR_REFERENCE_WITHDRAWN', '原 PR 引用已撤销，不自动恢复旧回执或重复创建；请核对平台后登记正确 PR');
      if (delivery.prUrl && delivery.prUrl !== delivery.gitPr?.url)
        fail('PR_MAPPING_CONFLICT', 'Git 回执与已纠正的 PR 引用不同，保留操作者引用；请核对原交付，不自动覆盖');
      if (!delivery.gitPr?.url)
        fail(
          'GIT_PR_LINK_UNKNOWN',
          'Git 推送已执行，但没有收到具体 PR 地址；请核对平台创建结果并补登记原 PR，程序不会再次创建或回退手工建单',
        );
      if ((await receiver.git.remoteBranch(delivery.branch)) !== delivery.candidate)
        fail('CANDIDATE_CONFLICT', 'Git 创建回执对应的候选分支已变化，不能登记');
      const heads = await receiver.git.heads();
      if (heads.internal !== delivery.base.internal) fail('PR_BASE_CHANGED', '创建期间内部 main 已变化，先恢复原交付');
      delivery.prUrl = delivery.gitPr.url;
      delivery.gitPr.status = 'CONFIRMED';
      delivery.prReference = { verifiedBy: 'git-receipt', time: new Date().toISOString() };
      delivery.status = 'WAITING_APPROVAL';
      delete delivery.error;
      event(
        state,
        delivery,
        'Git 已触发 PR 创建并返回具体地址，候选 ref 已回读；等待平台审核，不自动合入。未声称通过平台 API 核验 PR 属性',
      );
    },
    false,
  );
}
