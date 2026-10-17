import { createHash } from 'node:crypto';
import { mappedCommit } from './commit-policy.mjs';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { invokeIssue, verifyIssue } from './issue-adapter.mjs';
import { mapIssue, recordReceipts } from './metadata.mjs';
import { event } from './store.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function adapterIdentity(receiver, state) {
  if (!receiver.config.issues)
    fail('ISSUE_AUTOMATION_REQUIRED', '先在仓库设置配置真实 Issue 自动化；当前为人工登记方式');
  const identity = digest(receiver.config.issues);
  if (state.issueAdapterId && state.issueAdapterId !== identity)
    fail('ISSUE_ADAPTER_CHANGED', 'Issue 创建意图已有固定适配器，配置已改变；恢复原配置后继续，避免重复创建');
}
function requestFor(receiver, state, delivery, issue) {
  return {
    sourceId: issue.sourceId,
    key: digest([state.bindingId, issue.sourceId]),
    repository: receiver.config.internalWebUrl.replace(/\/$/, ''),
    issue,
    internalId: state.issues[issue.sourceId]?.internalId,
    ...(delivery.prUrl
      ? {
          pr: {
            url: delivery.prUrl,
            head: delivery.candidate,
            branch: delivery.branch,
            targetBranch: receiver.config.targetBranch,
          },
        }
      : {}),
  };
}
async function call(receiver, request, operation, allowMissing = false) {
  return verifyIssue(
    receiver.config,
    request,
    await invokeIssue(receiver.config, { ...request, operation }),
    allowMissing,
  );
}
export async function ensureIssues(receiver, state, delivery) {
  if (!delivery.issues.length) return;
  adapterIdentity(receiver, state);
  for (const issue of delivery.issues) {
    const request = requestFor(receiver, state, delivery, issue);
    await phase(
      'issue-create',
      `创建 / 复用并回读内部 Issue #${issue.number}`,
      async () => {
        const mapped = state.issues[issue.sourceId];
        let result = await call(receiver, request, mapped ? 'read' : 'find', !mapped);
        if (!result) {
          if (state.issueIntents?.[issue.sourceId])
            fail('ISSUE_CREATE_RESULT_UNKNOWN', '原 Issue 创建结果仍未查到；核对平台后重试回读，不会再次创建');
          state.issueAdapterId ??= digest(receiver.config.issues);
          state.issueIntents ??= {};
          state.issueIntents[issue.sourceId] = { key: request.key, time: new Date().toISOString() };
          await receiver.store.save(state);
          try {
            await call(receiver, request, 'create');
          } catch {
            fail('ISSUE_CREATE_RESULT_UNKNOWN', 'Issue 创建回执未确认；意图已保存，恢复时先回读原对象，不重复创建');
          }
          result = await call(receiver, request, 'find');
        }
        mapIssue(state, delivery, issue.sourceId, result.internalId, result.url);
        state.issueAdapterId ??= digest(receiver.config.issues);
        Object.assign(state.issues[issue.sourceId], { key: request.key, confirmedBy: 'platform', state: result.state });
        await receiver.store.save(state);
      },
      false,
    );
  }
}
function matchingLink(result, pr) {
  return result.links.some(
    (link) =>
      link.url === pr.url &&
      link.head === pr.head &&
      link.branch === pr.branch &&
      link.targetBranch === pr.targetBranch,
  );
}
export async function associateIssues(receiver, state, delivery) {
  if (!receiver.config.issues || !delivery.issues.length || !delivery.prUrl) return;
  adapterIdentity(receiver, state);
  delivery.issueLinks ??= {};
  for (const issue of delivery.issues) {
    const request = requestFor(receiver, state, delivery, issue);
    await phase(
      'issue-link',
      `关联并回读内部 PR 与 Issue #${issue.number}`,
      async () => {
        let result = await call(receiver, request, 'read');
        if (!matchingLink(result, request.pr)) {
          delivery.issueLinkIntents ??= {};
          delivery.issueLinkIntents[issue.sourceId] ??= { ...request.pr, time: new Date().toISOString() };
          await receiver.store.save(state);
          await call(receiver, request, 'link');
          result = await call(receiver, request, 'read');
        }
        if (!matchingLink(result, request.pr))
          fail('ISSUE_LINK_PENDING', 'PR 与 Issue 的实际关联尚未回读确认；保留原 PR，稍后重试关联核验');
        delivery.issueLinks[issue.sourceId] = { ...request.pr, verifiedAt: new Date().toISOString() };
        await receiver.store.save(state);
      },
      false,
    );
  }
}
export async function settleIssues(receiver, state, delivery) {
  if (!receiver.config.issues || delivery.status !== 'CODE_ACCEPTED_PENDING_METADATA') return;
  adapterIdentity(receiver, state);
  if ((await receiver.git.fetch()).internal !== delivery.acceptedInternal)
    fail('ACCEPTED_HEAD_CONFLICT', '内部 main 已改变，停止关单；先核对原接受版本');
  await associateIssues(receiver, state, delivery);
  const observations = [];
  for (const issue of delivery.issues) {
    const request = requestFor(receiver, state, delivery, issue);
    await phase(
      'issue-state',
      `回读 Issue #${issue.number}；接收条件满足后关单`,
      async () => {
        let result = await call(receiver, request, 'read');
        result = await settleClosing(receiver, state, delivery, issue, request, result);
        observations.push({ sourceId: issue.sourceId, internalId: result.internalId, state: result.state });
      },
      false,
    );
  }
  await phase(
    'receipts-save',
    '保存平台核验的 Issue 接收记录',
    () => recordReceipts(state, delivery, observations, receiver.git, 'platform'),
    false,
  );
  delivery.status = 'COMPLETE';
  delete delivery.error;
  state.queue.shift();
  event(state, delivery, '平台 Issue 创建、PR 关联与合入后状态已自动回读；本笔同步完成');
}
export async function syncIssues(receiver, state) {
  const delivery = receiver.requireActive(state);
  if (delivery.acceptedInternal) await settleIssues(receiver, state, delivery);
  else if (delivery.prUrl) await associateIssues(receiver, state, delivery);
  else await ensureIssues(receiver, state, delivery);
  delete delivery.error;
}

async function settleClosing(receiver, state, delivery, issue, request, result) {
  if (issue.relation === 'closes') {
    let pending = false;
    for (const target of issue.requiredTargets ?? [delivery.target])
      if (!(await receiver.git.isAncestor(mappedCommit(state, target), delivery.acceptedInternal))) pending = true;
    const desiredState = pending ? 'open' : 'closed';
    if (result.state !== desiredState) {
      delivery.issueUpdateIntents ??= {};
      delivery.issueUpdateIntents[issue.sourceId] = { desiredState, time: new Date().toISOString() };
      await receiver.store.save(state);
      await call(receiver, { ...request, desiredState }, 'update');
      result = await call(receiver, request, 'read');
    }
    if (result.state !== desiredState)
      fail('ISSUE_UPDATE_PENDING', 'Issue 状态写入尚未回读确认；代码已接受，只重试原 Issue 状态核验');
  }
  return result;
}
