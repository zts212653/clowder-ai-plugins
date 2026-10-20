import { mappedCommit } from './commit-policy.mjs';
import { fail, objectUrl } from './config.mjs';

export function mapIssue(state, delivery, sourceId, internalId, url, options = {}) {
  const issue = delivery.issues.find((item) => item.sourceId === sourceId);
  if (!issue || !/^[\w-]+$/.test(String(internalId))) fail('ISSUE_MAPPING_INVALID', '来源 Issue 或内部身份无效');
  const existing = state.issues[sourceId];
  if (existing && (existing.internalId !== String(internalId) || existing.url !== url)) {
    if (delivery.status !== 'ISSUES_REQUIRED' || delivery.candidate || existing.receipts.length)
      fail('ISSUE_MAPPING_FROZEN', '候选已冻结或 Issue 已有接收记录，不能改写映射；请在内部平台核对并保留原交付');
    if (options.previousId !== existing.internalId || options.previousUrl !== existing.url)
      fail('ISSUE_MAPPING_CONFLICT', '更换 Issue 需要确认当前编号和链接，请刷新后在纠正入口处理');
    const next = objectUrl(url);
    existing.history ??= [];
    existing.history.push({
      internalId: existing.internalId,
      url: existing.url,
      time: new Date().toISOString(),
    });
    existing.internalId = String(internalId);
    existing.url = next;
  }
  state.issues[sourceId] = existing ?? { internalId: String(internalId), url: objectUrl(url), receipts: [] };
}
export async function recordReceipts(state, delivery, observations, receiver, confirmedBy = 'operator') {
  const updates = [];
  for (const issue of delivery.issues) {
    updates.push(await observeIssue(state, delivery, issue, observations, receiver));
  }
  for (const { sourceId, mapping, pending, observation } of updates) {
    if (!mapping.receipts.some((receipt) => receipt.deliveryId === delivery.id))
      mapping.receipts.push({
        deliveryId: delivery.id,
        target: delivery.target,
        state: observation.state,
        pending,
        confirmedBy,
        time: new Date().toISOString(),
      });
    mapping.state = observation.state;
    delivery.issueResults[sourceId] = { state: observation.state, pending, recorded: true, confirmedBy };
  }
}
async function observeIssue(state, delivery, issue, observations, receiver) {
  const mapping = state.issues[issue.sourceId];
  const observation = observations.find((item) => item.sourceId === issue.sourceId);
  if (
    !mapping ||
    !observation ||
    observation.internalId !== mapping.internalId ||
    !['open', 'closed'].includes(observation.state)
  )
    fail('ISSUE_OBSERVATION_INVALID', '需要逐个确认正确映射的内部 Issue 状态');
  const pending = [];
  for (const target of issue.requiredTargets ?? [delivery.target]) {
    if (!(await receiver.isAncestor(mappedCommit(state, target), delivery.acceptedInternal))) pending.push(target);
  }
  if (issue.relation === 'closes') checkClosing(observation.state, pending);
  return { sourceId: issue.sourceId, mapping, pending, observation };
}
function checkClosing(status, pending) {
  if (pending.length && status !== 'open')
    fail('ISSUE_CLOSED_EARLY', '接收条件尚未完成，内部 Issue 被提前关闭；请先在平台处理');
  if (!pending.length && status !== 'closed')
    fail('ISSUE_UPDATE_PENDING', '接收条件已满足，仍需在内部平台关闭并回读确认');
}
export function templates(delivery, mappings = {}) {
  const source = delivery.source;
  return {
    title: `[上游同步] ${source.kind === 'commit' ? `主干提交 ${source.commit.slice(0, 12)}` : `PR #${source.number}`} · ${source.title}`,
    body: [
      `来源：${source.url}`,
      ...(source.kind === 'commit'
        ? ['来源类型：主干提交（无关联上游 PR），由系统自动识别纳入；内部仍创建正常审核 PR。']
        : []),
      `交付标识：${delivery.id}`,
      `上游范围：${delivery.base.upstream} → ${delivery.target}`,
      `候选 head：${delivery.candidate ?? '尚未准备'}`,
      `内部 base：${delivery.base.internal}`,
      '实际落地提交：',
      ...(delivery.commits ?? []),
      '',
      delivery.commitPolicy?.strategy === 'rewrite'
        ? '按冻结内部身份重写提交；以下映射用于追溯。'
        : '保留原始对象；在内部平台正常审核合入。',
      ...(delivery.commitMappings ?? []).map((item) => `${item.source} → ${item.internal}`),
      'Issue 对应：',
      ...delivery.issues.map(
        (issue) =>
          `${issue.url} → ${mappings[issue.sourceId] ? `内部 #${mappings[issue.sourceId].internalId} ${mappings[issue.sourceId].url}` : '请填写内部对象'}；关系：${issue.relation === 'closes' ? '接收条件完成后关闭' : '普通关联，保留状态'}`,
      ),
    ].join('\n'),
  };
}
