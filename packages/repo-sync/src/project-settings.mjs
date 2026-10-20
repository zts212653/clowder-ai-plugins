import { fail, validateConfig } from './config.mjs';
import { checkIssueSettings, issueConfiguration, issueInputKeys } from './issue-settings.mjs';
import { checkFrozenPr, prConfiguration } from './pr-settings.mjs';
export function projectConfiguration(previous, state, input) {
  const keys = [
    'action',
    'expectedRevision',
    'expectedBinding',
    'internalWebUrl',
    'prMode',
    ...issueInputKeys,
    'commitStrategy',
    'receivingIdentity',
    'commitClosureVerified',
    'autoMergeWaitMs',
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)))
    fail('INVALID_CONFIGURATION_INPUT', '设置只接受明确的可编辑字段，不接受地址绑定、命令或凭据');
  const next = { ...previous };
  if (input.internalWebUrl !== undefined) next.internalWebUrl = input.internalWebUrl;
  if (input.prMode !== undefined) next.pullRequests = prConfiguration(next, input.prMode, input);
  if (input.issueMode !== undefined) next.issues = issueConfiguration(next, input);
  for (const key of ['commitStrategy', 'receivingIdentity', 'autoMergeWaitMs'])
    if (input[key] !== undefined) next[key] = input[key];
  if (input.commitClosureVerified === true) next.commitClosureVerified = true;
  if (
    (state?.active || ['RUNNING', 'WAITING_REVIEW'].includes(state?.automation?.status)) &&
    (next.commitStrategy !== previous.commitStrategy ||
      JSON.stringify(next.receivingIdentity) !== JSON.stringify(previous.receivingIdentity))
  )
    fail('COMMIT_POLICY_FROZEN', '本笔提交身份已冻结；可查看，完成后再修改');
  validateConfig(next);
  checkIssueSettings(state, previous, next);
  checkFrozenPr(state?.active, previous, next, state);
  return next;
}
