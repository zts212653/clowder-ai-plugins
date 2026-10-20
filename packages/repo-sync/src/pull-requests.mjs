import { fail, objectUrl } from './config.mjs';
import { phase } from './execution.mjs';
import { validateGitPr } from './git-pr.mjs';
import { gitlabPr } from './gitlab-pr.mjs';
import { validateGitlabApi } from './issue-adapter.mjs';
import { command } from './process.mjs';
import { event } from './store.mjs';

export function validatePrConfig(config) {
  if (config.internalWebUrl) config.internalWebUrl = objectUrl(config.internalWebUrl).replace(/\/+$/, '');
  const adapter = config.pullRequests;
  if (!adapter) return;
  if (adapter.mode === 'git') return validateGitPr(config);
  if (adapter.mode === 'gitlab' && config.internalWebUrl) return validateGitlabApi(config, adapter);
  if (adapter.mode !== 'command' || !config.internalWebUrl)
    fail('INVALID_PR_ADAPTER', '自动 PR 需要 mode=command、内部网页仓库地址和固定查询/创建命令');
  for (const action of ['find', 'create']) {
    const value = adapter[action];
    if (
      !value ||
      typeof value.command !== 'string' ||
      !value.command ||
      !Array.isArray(value.args) ||
      !value.args.every((arg) => typeof arg === 'string')
    )
      fail('INVALID_PR_ADAPTER', '平台命令需要固定 executable 和字符串 args；仅在私有配置设置');
  }
  if (
    adapter.timeoutMs !== undefined &&
    (!Number.isInteger(adapter.timeoutMs) || adapter.timeoutMs < 1000 || adapter.timeoutMs > 600000)
  )
    fail('INVALID_PR_ADAPTER', '平台适配器超时需要 1000～600000 毫秒');
}
export function prUrl(config, url, kind = 'PR') {
  const value = objectUrl(url);
  const parsed = new URL(value);
  const repository = config.internalWebUrl;
  if (!repository && !config.allowLocal)
    fail(
      'INTERNAL_WEB_URL_REQUIRED',
      '尚未配置内部仓库网页地址，不能从 SSH 主机或端口推断。请在当前 PR 步骤或仓库设置填写 HTTPS 仓库首页，再登记具体 PR / Issue 链接；基线与候选保留',
    );
  if (repository) {
    const root = new URL(repository);
    if (parsed.origin !== root.origin || !parsed.pathname.startsWith(`${root.pathname.replace(/\/+$/, '')}/`))
      fail(
        kind === 'PR' ? 'PR_URL_MISMATCH' : 'ISSUE_URL_MISMATCH',
        `需要内部仓库下的具体 ${kind} 页面，不能填仓库首页、来源对象或其他仓库链接；请到仓库设置核对内部网页仓库地址，SSH 地址不参与网页来源比较`,
      );
  }
  if (parsed.pathname === '/') fail('PR_URL_MISMATCH', '请填写已经创建的具体 PR 页面地址');
  return value;
}
export async function linkPr(receiver, state, url, options = {}) {
  const delivery = receiver.requireActive(state);
  verifyReferenceChange(delivery, url, options);
  const next = url === null ? null : prUrl(receiver.config, url);
  const heads = await receiver.git.heads();
  if (heads.internal !== delivery.base.internal)
    fail('PR_ALREADY_MERGED', '内部合入分支已变化，不能退回或改链接；请先核验原交付的 Git 合入结果');
  if ((await receiver.git.remoteBranch(delivery.branch)) !== delivery.candidate)
    fail('CANDIDATE_CONFLICT', '远端候选分支已变化，先核对原交付，不能改 PR');
  if (delivery.prUrl && next !== delivery.prUrl) {
    delivery.prHistory ??= [];
    delivery.prHistory.push({
      url: delivery.prUrl,
      time: new Date().toISOString(),
      reason: next ? 'corrected' : 'withdrawn',
    });
  }
  if (next) delivery.prUrl = next;
  else delete delivery.prUrl;
  delivery.prReference = { verifiedBy: 'operator', time: new Date().toISOString(), withdrawn: !next };
  delivery.status = next ? 'WAITING_APPROVAL' : 'PR_REQUIRED';
  if (!next && state.automation && state.automation.status !== 'COMPLETE') {
    state.automation.status = 'PAUSED';
    state.automation.updatedAt = new Date().toISOString();
  }
  delete delivery.error;
  event(
    state,
    delivery,
    next
      ? '已登记/纠正内部 PR 引用；平台存在性与分支由操作者确认，Git 合入另行核验'
      : '已撤销错误 PR 引用；候选和历史保留，可登记正确 PR，不会删除平台对象',
  );
}
function verifyReferenceChange(delivery, url, options) {
  if (!['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status) || delivery.acceptedInternal)
    fail('PR_NOT_READY', '候选未发布或已接受，不能更换 PR；请恢复原交付');
  if (options.deliveryId && options.deliveryId !== delivery.id)
    fail('PR_MAPPING_CHANGED', '活动交付已变化，请刷新后核对');
  if (options.previousUrl !== undefined && options.previousUrl !== (delivery.prUrl ?? ''))
    fail('PR_MAPPING_CHANGED', 'PR 引用已被修改，请刷新核对；未覆盖新链接');
  if (delivery.prUrl && url !== delivery.prUrl && options.previousUrl === undefined)
    fail('PR_MAPPING_CONFLICT', '更换链接需要确认原链接；请使用纠正 PR 引用入口');
}
function payload(receiver, state, delivery) {
  return {
    schema: 1,
    deliveryId: delivery.id,
    repository: receiver.config.internalWebUrl,
    branch: delivery.branch,
    targetBranch: receiver.config.targetBranch,
    head: delivery.candidate,
    base: delivery.base.internal,
    title: state.templates?.title,
    body: state.templates?.body,
  };
}
async function invoke(config, action, input) {
  if (config.pullRequests.mode === 'gitlab') return gitlabPr(config, action, input);
  const spec = config.pullRequests[action];
  const text = await command(spec.command, spec.args, {
    input: JSON.stringify({ ...input, action }),
    timeout: config.pullRequests.timeoutMs ?? 120000,
  });
  try {
    return JSON.parse(text);
  } catch {
    fail('PR_ADAPTER_INVALID', '平台适配器必须返回 JSON，原始输出不进入网页；请在本机核对适配器');
  }
}
function validateResult(config, result, input) {
  if (
    !result ||
    Array.isArray(result) ||
    result.deliveryId !== input.deliveryId ||
    result.branch !== input.branch ||
    result.targetBranch !== input.targetBranch ||
    result.head !== input.head ||
    result.base !== input.base ||
    !['open', 'merged'].includes(result.state)
  )
    fail('PR_OBJECT_MISMATCH', '平台 PR 的交付身份、分支、base/head 或状态不匹配；暂停，不能登记或重复创建');
  return prUrl(config, result.url);
}
export async function createPr(receiver, state, delivery, templates) {
  if (delivery.prReference?.withdrawn)
    fail('PR_REFERENCE_WITHDRAWN', '原 PR 引用已由操作者撤销，不自动恢复或重复创建；请核对平台并登记正确的已创建 PR');
  if (!receiver.config.pullRequests)
    fail(
      'PR_ADAPTER_REQUIRED',
      '尚未配置平台创建能力。请在内部平台创建后登记，或在私有配置接入查询/创建适配器；Git 不创建 PR',
    );
  if (!['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status) || delivery.acceptedInternal)
    fail('PR_NOT_READY', '候选尚未发布或已接受，不能创建 PR');
  if (!delivery.checks?.passed || delivery.checks.head !== delivery.candidate)
    fail('CHECKS_REQUIRED', '候选检查未通过，不能创建 PR');
  const input = payload(receiver, { templates }, delivery);
  return phase(
    'platform-pr',
    '查询/创建并回读内部 PR',
    async () => {
      const heads = await receiver.git.heads();
      if (heads.internal !== input.base || (await receiver.git.remoteBranch(delivery.branch)) !== input.head)
        fail('PR_BASE_CHANGED', '内部基线或候选变化，先恢复原交付');
      let found = await invoke(receiver.config, 'find', input);
      if (!found) {
        if (delivery.prCreation || delivery.prUrl)
          fail(
            'PR_CREATE_RESULT_UNKNOWN',
            '原 PR 创建或引用结果仍不明。只查询原交付，不会再次创建；请在平台核对后登记正确链接',
          );
        delivery.prCreation = { status: 'INTENT_SAVED', deliveryId: delivery.id };
        await receiver.store.save(state);
        await invoke(receiver.config, 'create', input);
        found = await invoke(receiver.config, 'find', input);
      }
      const url = validateResult(receiver.config, found, input);
      if (delivery.prUrl && delivery.prUrl !== url)
        fail('PR_MAPPING_CONFLICT', '平台查询结果与已登记链接不同，请先核对并通过纠正入口处理；未覆盖人工引用');
      delivery.prUrl = url;
      delivery.prReference = { verifiedBy: 'adapter', time: new Date().toISOString() };
      delivery.prCreation = { status: 'CONFIRMED', deliveryId: delivery.id };
      delivery.status = 'WAITING_APPROVAL';
      delete delivery.error;
      event(state, delivery, '平台 PR 已查询回读，交付身份、分支与冻结 base/head 相符；等待平台审核，不自动合入');
    },
    false,
  );
}
