import type { TaskItem } from './business/model/index.js';
import type { DeliveryReceipt } from './migration-source.js';
import type { LegacyReadPort, LegacySourceScope } from './operational-source.js';
import { pendingReceipt } from './operational-source-receipts.js';
import { hash, identifier, json, number, ownedThread, record, taskFields } from './operational-source-values.js';

export async function legacyTasks(reader: LegacyReadPort, scope: LegacySourceScope, signal: AbortSignal) {
  const tasks: TaskItem[] = [],
    receipts: DeliveryReceipt[] = [],
    refs: string[] = [],
    members: string[] = [];
  for (const kind of ['pr_tracking', 'issue_tracking'] as const) {
    const index = scope.keyPrefix + 'tasks:kind:' + kind,
      count = number(await reader.read('ZCARD', index));
    if (count > 10000) throw new Error('Task index exceeds bounded source scope');
    for (let offset = 0; offset < count; offset += 256) {
      const ids = await reader.read('ZRANGE', index, String(offset), String(Math.min(offset + 255, count - 1)));
      if (!Array.isArray(ids) || ids.length !== Math.min(256, count - offset))
        throw new Error('Task index changed during source read');
      for (const value of ids) {
        signal.throwIfAborted();
        if (typeof value !== 'string') throw new Error('Invalid task index');
        const id = identifier(value);
        if (scope.excludedTaskIds.includes(id))
          throw new Error('Excluded Task appears in GitHub index; no Task read performed');
        const key = scope.keyPrefix + 'task:' + id,
          identity = await hash(reader, key, ['id', 'kind', 'userId', 'threadId']);
        if (identity.id !== id || identity.kind !== kind || !identity.threadId)
          throw new Error('Corrupt GitHub task index');
        members.push(id);
        if (identity.userId && identity.userId !== scope.ownerUserId) continue;
        if (!(await ownedThread(reader, scope, identity.threadId)))
          throw new Error('Source thread ownership unavailable');
        const state = await hash(reader, key, ['status', 'automationState']);
        const automation = state.automationState ? record(json(state.automationState)) : {};
        const outcome = automation.waitOutcome ? record(automation.waitOutcome) : undefined;
        const issue = automation.issue ? record(automation.issue) : undefined;
        const pending = outcome?.delivery === 'pending' || !!issue?.pendingWake;
        if (state.status === 'done' && !pending) continue;
        for (const field of ['pluginWait', 'entrustedWork'])
          if (number(await reader.read('HEXISTS', key, field))) throw new Error('Unsupported active Host obligation');
        const raw = await hash(reader, key, taskFields);
        const subject = /^(?:pr|issue):([^#]+)#[1-9]\d*$/.exec(raw.subjectKey ?? '');
        if (!subject || !scope.repositories.includes(subject[1]!))
          throw new Error('Owned tracking repository is outside approved scope');
        if (!raw.userId) delete raw.userId;
        const task = {
          ...raw,
          createdAt: Number(raw.createdAt),
          updatedAt: Number(raw.updatedAt),
          ...(raw.automationState ? { automationState: json(raw.automationState) } : {}),
        } as unknown as TaskItem;
        tasks.push(task);
        const receipt = await pendingReceipt(reader, scope, task);
        if (receipt) receipts.push(receipt);
        for (const field of ['typedWaitRegistration', 'invocationLease', 'claimHistory']) {
          const present = number(await reader.read('HEXISTS', key, field));
          refs.push(`legacy:${id}:${field}:${present ? 'present' : 'absent'}`);
        }
      }
    }
    if (number(await reader.read('ZCARD', index)) !== count) throw new Error('Task membership changed');
  }
  return { tasks, receipts, refs, members: members.sort() };
}
