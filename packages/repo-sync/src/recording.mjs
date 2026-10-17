import { createHash } from 'node:crypto';
import { phaseStage, workflowPlanVersion } from '../web/workflow-plan.mjs';
import { fail, safeUrl } from './config.mjs';
import { execution } from './execution.mjs';

const fields = [
  'bindingId',
  'sourceUrl',
  'internalUrl',
  'internalWebUrl',
  'sourceBranch',
  'targetBranch',
  'mode',
  'internalPaths',
  'mergePaths',
  'checkProfile',
  'checkCount',
  'prTransport',
  'commitClosureVerified',
];
const optionalFields = ['commitStrategy', 'receivingIdentity', 'autoMergeWaitMs'];
export function configSnapshot(config) {
  const snapshot = {};
  for (const key of [...fields, ...optionalFields])
    if (config[key] !== undefined) snapshot[key] = structuredClone(config[key]);
  snapshot.checkCount = config.checks?.length ?? 0;
  snapshot.prTransport = config.pullRequests?.mode ?? 'manual';
  snapshot.checkProfile = config.checkProfile === 'git-integrity' ? 'git-integrity' : 'custom';
  snapshot.checkConfigId = digest(config.checks ?? []);
  snapshot.prConfigId = digest(config.pullRequests ?? null);
  snapshot.issueTransport = config.issues?.mode ?? 'manual';
  snapshot.issueConfigId = digest(config.issues ?? null);
  snapshot.fingerprint = fingerprint(snapshot);
  return snapshot;
}
function fingerprint(snapshot) {
  const entries = fields.map((key) => [key, snapshot[key]]);
  for (const key of [...optionalFields, 'checkConfigId', 'prConfigId', 'issueTransport', 'issueConfigId'])
    if (snapshot[key] !== undefined) entries.push([key, snapshot[key]]);
  return digest(entries);
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).some(
      (key) =>
        ![
          ...fields,
          ...optionalFields,
          'fingerprint',
          'checkConfigId',
          'prConfigId',
          'issueTransport',
          'issueConfigId',
        ].includes(key),
    ) ||
    snapshot.fingerprint !== fingerprint(snapshot) ||
    !Number.isInteger(snapshot.checkCount) ||
    snapshot.checkCount < 0 ||
    !['manual', 'git', 'command', 'gitlab'].includes(snapshot.prTransport) ||
    !['custom', 'git-integrity'].includes(snapshot.checkProfile)
  )
    fail('RECORD_INVALID', '历史配置摘要损坏或版本不支持，保留原记录，不能用当前配置替代');
  for (const key of ['checkConfigId', 'prConfigId', 'issueConfigId'])
    if (snapshot[key] !== undefined && !/^[a-f0-9]{64}$/.test(snapshot[key]))
      fail('RECORD_INVALID', '历史检查 / PR 配置标识无效');
  validateIssueSnapshot(snapshot);
  for (const key of ['sourceUrl', 'internalUrl', 'internalWebUrl'])
    if (snapshot[key] !== undefined) safeUrl(snapshot[key], true);
  for (const key of ['internalPaths', 'mergePaths'])
    if (
      snapshot[key] !== undefined &&
      (!Array.isArray(snapshot[key]) || snapshot[key].some((path) => typeof path !== 'string'))
    )
      fail('RECORD_INVALID', '历史文件规则格式无效');
  return snapshot;
}
export function recordDelivery(delivery, config, source = 'execution', mappings = {}) {
  delivery.recordSchema ??= 1;
  delivery.taskIds ??= [];
  delivery.configurations ??= [];
  delivery.issueMappings ??= {};
  for (const issue of delivery.issues ?? [])
    if (mappings[issue.sourceId]) {
      const { internalId, url } = mappings[issue.sourceId];
      delivery.issueMappings[issue.sourceId] = { internalId, url };
    }
  const context = execution();
  if (context?.taskId && !delivery.taskIds.includes(context.taskId)) delivery.taskIds.push(context.taskId);
  const snapshot = configSnapshot(config);
  if (delivery.configurations.at(-1)?.snapshot.fingerprint !== snapshot.fingerprint)
    delivery.configurations.push({
      time: new Date().toISOString(),
      source,
      taskId: context?.taskId ?? null,
      snapshot,
    });
  if (source === 'start') {
    delivery.startedAt = new Date().toISOString();
    delivery.workflowPlanVersion = workflowPlanVersion;
  }
  if (['COMPLETE', 'CANCELLED'].includes(delivery.status)) delivery.finishedAt ??= new Date().toISOString();
  context?.associate?.(delivery.id);
}
export function validateRecording(delivery) {
  if (delivery.workflowPlanVersion !== undefined && delivery.workflowPlanVersion !== workflowPlanVersion)
    fail('RECORD_INVALID', '同步流程计划版本不支持，保留原记录');
  if (delivery.recordSchema === undefined) return;
  if (
    delivery.recordSchema !== 1 ||
    !Array.isArray(delivery.taskIds) ||
    !Array.isArray(delivery.configurations) ||
    new Set(delivery.taskIds).size !== delivery.taskIds.length ||
    delivery.taskIds.some((id) => !/^[a-f0-9]{32}$/.test(id)) ||
    delivery.configurations.some(
      (item) =>
        !item ||
        !Number.isFinite(Date.parse(item.time)) ||
        !['start', 'execution', 'configuration'].includes(item.source),
    )
  )
    fail('RECORD_INVALID', '同步历史记录版本、任务或配置关联无效，保留原文件');
  for (const item of delivery.configurations) validateSnapshot(item.snapshot);
  for (const key of ['startedAt', 'finishedAt'])
    if (delivery[key] !== undefined && !Number.isFinite(Date.parse(delivery[key])))
      fail('RECORD_INVALID', '同步历史时间无效');
}
export function phaseLocation(action, key, parent) {
  if (
    parent?.stage === 5 &&
    !['merge-intent', 'platform-merge', 'merge-readiness', 'platform-review', 'merge-observe'].includes(key)
  )
    return { stage: 5, group: parent.group };
  const planned = phaseStage(key);
  if (
    planned &&
    !['source-probe', 'internal-probe', 'source-fetch', 'internal-fetch', 'object-store'].includes(key)
  )
    return { stage: planned, group: planned === 4 ? 'approval' : 'objects' };
  if (key === 'delivery-verify') return { stage: 5, group: 'result' };
  if (key === 'delivery-start') return { stage: 1, group: 'objects' };
  if (key === 'delivery-prepare') return { stage: 2, group: 'content' };
  if (parent?.stage === 5) return { stage: 5, group: parent.group };
  const stage =
    {
      start: 1,
      discover: 1,
      tags: 1,
      'select-tag': 1,
      heads: 0,
      adopt: 0,
      issue: 2,
      'sync-issues': 5,
      prepare: 2,
      resolve: 2,
      'cancel-version': 2,
      'cancel-delivery': 4,
      'configure-auto-merge': 4,
      'inspect-delivery-source': 1,
      pr: 3,
      'clear-pr': 3,
      'create-pr': 3,
      recover: 5,
      receipts: 5,
      synchronize: 1,
      'resume-sync': 5,
    }[action] ?? 0;
  if (
    parent &&
    [
      'source-probe',
      'internal-probe',
      'source-fetch',
      'internal-fetch',
      'object-store',
      'source-tags',
      'tag-fetch',
    ].includes(key)
  )
    return { stage: parent.stage, group: parent.group };
  if (['platform-pr', 'candidate-publish', 'candidate-ref', 'publish-intent'].includes(key))
    return { stage: 3, group: 'publish' };
  if (key === 'issue-link') return { stage: 3, group: 'issues' };
  if (key === 'issue-create') return { stage: 2, group: 'issues' };
  if (key === 'issue-state') return { stage: 5, group: 'issues' };
  if (['merge-verify', 'acceptance-save', 'receipts-save', 'execution-record'].includes(key))
    return { stage: 5, group: 'result' };
  if (
    ['candidate-build', 'conflict-resolution', 'internal-preserve', 'file-merge', 'file-rules'].includes(key)
  )
    return { stage: 2, group: 'content' };
  if (key === 'candidate-check') return { stage: 2, group: 'checks' };
  if (key === 'ledger-save') return { stage: parent?.stage ?? stage, group: 'record' };
  return { stage, group: 'objects' };
}

function validateIssueSnapshot(snapshot) {
  if (
    snapshot.issueTransport !== undefined &&
    !['manual', 'command', 'gitlab'].includes(snapshot.issueTransport)
  )
    fail('RECORD_INVALID', '历史 Issue 适配方式无效');
}
