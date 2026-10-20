import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readText } from './atomic-file.mjs';
import { fail } from './config.mjs';
import { writePrivate } from './private-config.mjs';
import { validateSnapshot } from './recording.mjs';

export const taskActions = new Set([
  'inspect-baseline',
  'preview-sync',
  'synchronize',
  'resume-sync',
  'pause-sync',
  'configure-continuation',
  'configure-auto-merge',
  'heads',
  'adopt',
  'discover',
  'prepare',
  'recover',
  'tags',
  'select-tag',
  'pr',
  'clear-pr',
  'create-pr',
  'start',
  'issue',
  'sync-issues',
  'receipts',
  'resolve',
  'cancel-version',
  'cancel-delivery',
  'inspect-exit', 'preview-repair', 'prepare-repair', 'link-repair', 'check-repair',
  'inspect-repair-exit', 'retire-repair',
  'inspect-delivery-source',
]);
const keys = new Set([
  'runId',
  'continuation',
  'observeOnly',
  'action',
  'requestId',
  'projectId',
  'upstream',
  'internal',
  'tag',
  'targetKind',
  'targetValue',
  'includeDirectCommits',
  'deliveryId',
  'expectedBinding',
  'expectedRevision',
  'url',
  'previousUrl',
  'expectedTarget',
  'sourceId',
  'internalId',
  'previousId',
  'observations',
  'path',
  'choice',
  'content',
  'confirmed',
  'autoMerge',
  'inspectionId', 'manualDisposition', 'planId',
]);
export function taskInput(input) {
  if (input?.manualDisposition !== undefined && (!['cancel-delivery', 'retire-repair'].includes(input.action) || !['closed', 'no-pr'].includes(input.manualDisposition)))
    fail('INVALID_TASK_INPUT', '退出确认只接受原 PR 已关闭或确认未创建 PR。');
  for (const key of ['inspectionId', 'planId'])
    if (input?.[key] !== undefined && !/^[a-f0-9]{64}$/.test(input[key]))
      fail('INVALID_TASK_INPUT', '退出检查或修复预览身份无效，请刷新核对。');
  if (input?.autoMerge !== undefined && (!['synchronize', 'configure-auto-merge'].includes(input.action) || typeof input.autoMerge !== 'boolean'))
    fail('INVALID_AUTO_MERGE', '自动合入必须是本轮明确选择的布尔值。');
  if (
    input?.continuation !== undefined &&
    (!['synchronize', 'configure-continuation'].includes(input.action) ||
      !['automatic', 'after-each'].includes(input.continuation))
  )
    fail('INVALID_TASK_INPUT', '后续处理方式只接受连续同步或每笔完成后暂停。');
  if (input?.observeOnly !== undefined && (input.action !== 'resume-sync' || typeof input.observeOnly !== 'boolean'))
    fail('INVALID_TASK_INPUT', '后台观察只能用于原轮次恢复，且需要布尔值。');
  if (
    input?.includeDirectCommits !== undefined &&
    (input.action !== 'discover' || typeof input.includeDirectCommits !== 'boolean')
  )
    fail('INVALID_TASK_INPUT', '无 PR 提交确认只适用于本轮读取，且需要布尔值。');
  if (!taskActions.has(input?.action)) fail('UNKNOWN_ACTION', '此操作不支持后台执行');
  if (!/^[a-f0-9]{32}$/.test(input.requestId ?? '') || Object.keys(input).some((key) => !keys.has(key)))
    fail('INVALID_TASK_INPUT', '任务需要有效请求标识和受限操作参数');
  if (input.projectId !== undefined && input.projectId !== 'default' && !/^[a-f0-9]{24}$/.test(input.projectId))
    fail('INVALID_TASK_INPUT', '任务项目身份无效，不能操作其他项目');
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(input)
          .sort()
          .map((key) => [key, input[key]]),
      ),
    )
    .digest('hex');
}
export function taskPlan(action) {
  const probes = [
    ['source-probe', '检查外部连接与分支'],
    ['internal-probe', '检查内部连接与分支'],
  ];
  const fetch = [
    ...probes,
    ['object-store', '准备私有对象目录'],
    ['source-fetch', '下载外部对象'],
    ['internal-fetch', '下载内部对象'],
  ];
  const plans = {
    heads: probes,
    discover: [
      ['github-auth', '检查已提供 GitHub API 读取认证'],
      ['github-repository', '读取 GitHub 仓库元数据'],
      ...fetch,
      ['target-check', '核验目标与来源分支的提交关系'],
      ['github-deliveries', '读取并核对 PR / Issue / commit 对应'],
    ],
    adopt: [...fetch, ['baseline-check', '核验 U0 / I0 与历史'], ['baseline-save', '登记已有基线']],
    'inspect-baseline': [...fetch, ['baseline-check', '核验历史起点与内部当前位置（尚未启用）']],
    tags: [['source-tags', '读取上游 tag']],
    'select-tag': [...fetch, ['target-check', '核验发布 tag 与已接收版本的关系']],
    pr: [['platform-pr', '核验候选并登记 PR 引用']],
    'clear-pr': [['platform-pr', '核验未合入并撤销错误引用']],
    'create-pr': [['platform-pr', '查询/创建并回读内部 PR']],
    issue: [['issue-mapping', '登记 / 纠正 Issue 来源映射']],
    resolve: [['conflict-resolution', '保存当前交付的冲突处理']],
    'cancel-version': [['version-cancel', '撤销当前未发布版本交付']],
    'cancel-delivery': [['cancel-intent', '保存撤销意图'], ['cancel-pr', '关闭原 PR 并回读']],
    'inspect-exit': [['exit-inspect', '核对内部 main、原候选与 PR']],
    'preview-repair': [['exit-inspect', '核对原合入与修复差异']],
    'prepare-repair': [['exit-inspect', '核对修复基线'], ['repair-build', '构造 landing 修复提交'],
      ['repair-check', '检查修复候选'], ['repair-publish', '发布独立修复分支'], ['platform-pr', '创建或回读修复 PR']],
    'link-repair': [['exit-inspect', '核对并登记修复 PR']],
    'check-repair': [['repair-verify', '核验修复 PR 合入结果'], ['issue-state', '回读原 Issue 并完成接收']],
    'inspect-repair-exit': [['exit-inspect', '核对修复候选与 PR']],
    'retire-repair': [['cancel-intent', '保存修复退出意图'], ['cancel-pr', '关闭原修复 PR 并回读']],
    'configure-auto-merge': [['merge-policy', '保存本轮自动合入选择']],
      'inspect-delivery-source': [['pr-history', '读取原 PR 开发提交清单']],
  };
  return (plans[action] ?? fetch).map(([key, label]) => ({
    id: key,
    key,
    label,
    status: 'PENDING',
  }));
}
export async function readTask(config, id) {
  if (!config?.stateDir) return null;
  const explicit = Boolean(id);
  let indexed = false;
  try {
    const folder = join(config.stateDir, 'operations');
    if (!id) {
      id = JSON.parse(await readText(join(folder, 'latest.json'))).id;
      indexed = true;
    }
    if (!/^[a-f0-9]{32}$/.test(id)) fail('TASK_UNREADABLE', '任务记录格式无效，请在本机核对');
    const value = JSON.parse(await readText(join(folder, `${id}.json`)));
    // 旧版本把"没有交付"写成空字符串；这里先归一化，避免一条历史记录让整个项目读不出来。
    if (value && value.deliveryId === '') value.deliveryId = null;
    validateTaskVersion(value);
    if (value.bindingId !== config.bindingId) {
      if (explicit) fail('TASK_BINDING_CHANGED', '原请求属于其他仓库绑定，暂停；不可当成未使用的请求标识覆盖');
      return null;
    }
    if (
      value.id !== id ||
      !taskActions.has(value.action) ||
      !['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(
        value.status,
      ) ||
      !Number.isInteger(value.ownerPid) ||
      value.ownerPid < 1 ||
      !/^[a-f0-9]{64}$/.test(value.inputHash ?? '') ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      !Array.isArray(value.steps) ||
      value.steps.some(
        (step) =>
          !step ||
          typeof step.id !== 'string' ||
          typeof step.label !== 'string' ||
          !['PENDING', 'RUNNING', 'DONE', 'FAILED'].includes(step.status),
      )
    )
      fail('TASK_UNREADABLE', '任务记录缺少有效状态、执行器或步骤，暂停；不可当成已完成或自动重建');
    return value;
  } catch (error) {
    if (error.safeToDisplay) throw error;
    if (error.code === 'ENOENT' && !indexed) return null;
    fail('TASK_UNREADABLE', '任务记录无法读取，保留原文件；请在本机核对');
  }
}
export async function saveTask(config, value, first = false) {
  if (!config?.stateDir) return;
  const folder = join(config.stateDir, 'operations');
  await mkdir(folder, { recursive: true });
  await writePrivate(join(folder, `${value.id}.json`), value);
  if (first) await writePrivate(join(folder, 'latest.json'), { id: value.id });
}
export function publicTask(value, owned, canRetryPersistence = false) {
  if (!value) return null;
  const { id, action, status, startedAt, updatedAt, finishedAt, steps, result, error, cancellable } = value;
  return {
    id,
    schema: value.schema,
    deliveryId: value.deliveryId,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    configSnapshot: value.configSnapshot,
    action,
    status,
    startedAt,
    updatedAt,
    finishedAt,
    deliveryIds: value.deliveryIds,
    steps: steps.map(
      ({ id, key, stage, group, parentId, deliveryId, label, status, startedAt, finishedAt, progress, error }) => ({
        deliveryId,
        id,
        key,
        stage,
        group,
        parentId,
        label,
        status,
        startedAt,
        finishedAt,
        progress,
        error,
      }),
    ),
    result,
    error,
    ...(value.persistence
      ? {
          persistence: {
            ...value.persistence,
            canRetry: Boolean(owned && canRetryPersistence),
          },
        }
      : {}),
    cancellable: Boolean(owned && cancellable && status === 'RUNNING'),
  };
}

function validateTaskVersion(value) {
  validateDeliveryIds(value);
  if (value.projectId !== undefined && value.projectId !== 'default' && !/^[a-f0-9]{24}$/.test(value.projectId))
    fail('TASK_UNREADABLE', '任务项目身份损坏，保留原记录');
  if (value.schema !== undefined && value.schema !== 2) fail('TASK_UNREADABLE', '任务记录版本不支持，不能当旧格式重建');
  if (value.schema === 2) {
    if (value.deliveryId != null && value.deliveryId !== '' && !/^[a-f0-9]{24}$/.test(value.deliveryId))
      fail('TASK_UNREADABLE', '任务同步身份无效');
    try {
      validateSnapshot(value.configSnapshot);
    } catch {
      fail('TASK_UNREADABLE', '任务配置摘要损坏，保留原记录');
    }
    if (
      value.steps?.some(
        (step) => !Number.isInteger(step.stage) || step.stage < 0 || step.stage > 5 || typeof step.group !== 'string',
      )
    )
      fail('TASK_UNREADABLE', '任务步骤归属无效');
  }
}

function validateDeliveryIds(value) {
  if (
    value.deliveryIds !== undefined &&
    (!Array.isArray(value.deliveryIds) || value.deliveryIds.some((id) => !/^[a-f0-9]{24}$/.test(id)))
  )
    fail('TASK_UNREADABLE', '任务多笔交付关联无效。');
}
