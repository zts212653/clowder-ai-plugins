import { fail, objectUrl } from './config.mjs';

export async function checkPlan(receiver, plan, base, head) {
  if (
    !(await receiver.isAncestor(base, plan.target)) ||
    !(await receiver.isAncestor(plan.target, head)) ||
    base === plan.target
  )
    fail('NONCONTIGUOUS_PLAN', '交付目标不在连续上游接受路径中');
  objectUrl(plan.source.url);
  if (typeof plan.source.id !== 'string' || !plan.source.id) fail('SOURCE_UNPROVEN', '上游来源稳定身份不完整');
  if (
    plan.source.kind === 'commit' &&
    (plan.source.commit !== plan.target || plan.source.number !== undefined || !plan.source.id.startsWith('commit:'))
  )
    fail('SOURCE_UNPROVEN', '独立主干提交的来源 SHA 或身份不一致，不能伪造 PR。');
  for (const issue of plan.issues) await checkIssue(receiver, issue);
}
async function checkIssue(receiver, issue) {
  objectUrl(issue.url);
  if (
    typeof issue.sourceId !== 'string' ||
    !issue.sourceId ||
    ['__proto__', 'constructor', 'prototype'].includes(issue.sourceId) ||
    !['related', 'closes'].includes(issue.relation)
  )
    fail('SOURCE_UNPROVEN', 'Issue 来源或关系证据不完整');
  for (const target of issue.requiredTargets ?? []) await receiver.sha(target);
}
