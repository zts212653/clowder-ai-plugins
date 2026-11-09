import type { FeatureContext, PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { decodeWaitTask, waitKey } from './typed-wait-record.js';
import { decodeCollection } from './community-collection-record.js';
import { decodeMigratedIssue } from './migrated-issue-record.js';
import { eventKey } from './business/domains/community/journal-directory.js';
import { diagnosticError } from './tracking-diagnostics.js';
import { typedWaitPolling } from './typed-wait-status.js';

export type StatusSource = 'typed' | 'collection' | 'migratedIssues' | 'journal' | 'diagnostics';
interface StatusItem { diagnostic?: Record<string, unknown>; recovery?: Record<string, unknown>; tracking?: Record<string, unknown> }
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Only bounded scalar facts cross the status boundary; retained histories stay with their owner. */
function scalars(value: unknown, names: readonly string[], maxLength = 2000) {
  const row = object(value), result: Record<string, unknown> = {};
  for (const name of names) {
    const item = row[name];
    if (typeof item === 'string') {
      result[name] = item.slice(0, maxLength);
      if (item.length > maxLength) {
        const omitted = result.omittedFields as string[] | undefined;
        result.omittedFields = [...(omitted ?? []), name];
      }
    } else if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || item === null)
      result[name] = item;
  }
  return result;
}

function taskSummary(task: TaskItem) {
  if (bytes(task) <= 8000) return structuredClone(task) as unknown as Record<string, unknown>;
  const summary = scalars(task, ['id', 'kind', 'subjectKey', 'userId', 'ownerCatId', 'threadId', 'title', 'status', 'createdAt', 'updatedAt'], 500);
  const automation = object(task.automationState);
  summary.automationState = {
    ...(automation.await ? { await: scalars(automation.await, ['v', 'generation', 'subjectRef', 'expiresAt', 'autoRenew', 'createdAt']) } : {}),
    ...(automation.waitOutcome ? { waitOutcome: scalars(automation.waitOutcome, ['generation', 'reason', 'at', 'delivery', 'outcomeId']) } : {}),
    ...(automation.issue ? { issue: scalars(automation.issue, ['lastCommentCursor', 'lastDeliveredCursor', 'issueState']) } : {}),
    ...(automation.ci ? { ci: scalars(automation.ci, ['headSha', 'prState', 'lastStatus']) } : {}),
  };
  summary.omittedFields = ['automationState', 'why', 'notification'];
  return summary;
}

async function safeError(error: unknown, secrets: FeatureContext['secrets']) {
  const safe = await diagnosticError(error, secrets);
  return { ...scalars(safe, ['name', 'message', 'code', 'signal'], 2000),
    ...(safe.stack || safe.stderr || safe.cause || safe.truncated ? { detailOmitted: true } : {}) };
}

function rawFacts(row: Record<string, unknown>) {
  return row.recovery && typeof row.recovery === 'object' ? object(row.recovery) : {
    disposition: row.disposition ?? 'unknown', reasonCode: row.reasonCode ?? 'recovery_not_prepared',
  };
}

function boundedItem(item: StatusItem, source: StatusSource, sourceKey: string, entry: PluginStorageEntry): StatusItem {
  if (bytes(item) <= 24_000) return item;
  // A corrupt, oversized row advances as an explicit anchor instead of trapping the cursor forever.
  const row = object(entry.value), task = object(row.task);
  if (source === 'diagnostics') return { diagnostic: { sourceKey, sourceRevision: entry.revision,
    ...scalars(row, ['requestKey', 'subject', 'catId', 'threadId', 'phase', 'status', 'code'], 500), omittedFields: ['record_detail'] } };
  return { recovery: { sourceKey, sourceRevision: entry.revision,
    ...(typeof task.id === 'string' && task.id.length <= 500 ? { taskId: task.id } : {}),
    recovery: scalars(rawFacts(row), ['scope', 'revision', 'disposition', 'reasonCode'], 500), omittedFields: ['record_detail'] } };
}

export async function statusMetadata(storage: PluginStorageHost, source: StatusSource, value: unknown) {
  const row = object(value), task = object(row.task);
  let route: Record<string, unknown> = {};
  if (source === 'journal' && typeof object(row.route).sourceEventId === 'string') {
    const event = object((await storage.get(eventKey(object(row.route).sourceEventId as string)))?.value);
    const original = object(event.event);
    if (original.subjectKey === row.subject && original.sourceEventId === object(row.route).sourceEventId)
      route = object(original.payload);
  }
  return { subject: source === 'diagnostics' ? row.subject : source === 'journal' ? row.subject : task.subjectKey,
    catId: source === 'diagnostics' ? row.catId : source === 'journal' ? route.catId : task.ownerCatId,
    threadId: source === 'diagnostics' ? row.threadId : source === 'journal' ? row.ownerThread ?? route.ownerThreadId : task.threadId,
    userId: source === 'journal' ? route.userId : task.userId,
    needsAttention: source === 'diagnostics' ? row.status === 'failed' : rawFacts(row).disposition === 'needs_attention' };
}

export async function projectStatus(source: StatusSource, sourceKey: string, entry: PluginStorageEntry, secrets: FeatureContext['secrets']): Promise<StatusItem> {
  const row = object(entry.value);
  if (source === 'diagnostics') return boundedItem({ diagnostic: {
    ...scalars(row, ['requestKey', 'subject', 'catId', 'threadId', 'at', 'attempts', 'phase', 'status', 'code', 'statusCode']),
    ...(row.error ? { error: await safeError(row.error, secrets) } : {}),
  } }, source, sourceKey, entry);
  const facts = rawFacts(row);
  const recovery: Record<string, unknown> = scalars(facts,
    ['v', 'scope', 'index', 'revision', 'nextPollAt', 'nextAt', 'failures', 'disposition', 'reasonCode', 'pending', 'lastFailureAt']);
  if (facts.notices) {
    const notices = Object.values(object(facts.notices));
    recovery.noticeSummary = { total: notices.length, pending: notices.filter(n => object(n).state === 'pending').length,
      needsAttention: notices.filter(n => object(n).state === 'needs_attention').length };
  }
  if (facts.lastError) recovery.lastError = await safeError(facts.lastError, secrets);
  const task = object(row.task);
  const diagnostic = { sourceKey, sourceRevision: entry.revision,
    ...scalars(task, ['id', 'subjectKey', 'ownerCatId', 'threadId'], 500),
    ...(typeof task.id === 'string' && task.id.length <= 500 ? { taskId: task.id } : {}),
    ...(source === 'journal' ? scalars({ subjectKey: row.subject }, ['subjectKey'], 500) : {}),
    recovery, ...scalars({ noticeState: object(row.notice).state }, ['noticeState'], 80) };
  let valid: TaskItem | undefined;
  try {
    if (source === 'typed') { valid = decodeWaitTask(entry.value); if (sourceKey !== waitKey(valid.id)) valid = undefined; }
    if (source === 'migratedIssues') valid = decodeMigratedIssue(entry.value, sourceKey).task;
    if (source === 'collection') decodeCollection(entry.value, sourceKey);
  } catch { /* Report this retained source without pretending malformed business data is a healthy task. */ }
  const result = { recovery: diagnostic, ...(valid ? { tracking: { ...taskSummary(valid),
    ...(source === 'typed' ? { polling: typedWaitPolling(valid, facts) } : {}) } } : {}) };
  return boundedItem(result, source, sourceKey, entry);
}
