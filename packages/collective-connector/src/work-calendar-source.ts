import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import {
  collectiveSourceIdentitySchema,
  collectiveWorkCalendarItemSchema,
  type CollectiveWorkCalendarItem,
} from './business/contracts/index.js';
import type { CollectiveConnector } from './business/connector/connector.js';
import { assertCollectiveWorkTask } from './collective-work-thread.js';
import { readWorkStoredReceipt } from './owner-work-first-receipt.js';

type Ports = Pick<FeatureContext, 'pluginInstanceId' | 'tasks' | 'messaging' | 'storage'>;

export async function readCollectiveWorkCalendarSource(
  connector: CollectiveConnector,
  ports: Ports,
  ownerUserId: string,
  current: () => Promise<void> = async () => {},
) {
  await current();
  const items: CollectiveWorkCalendarItem[] = [],
    unavailableTaskIds: string[] = [];
  for (const task of await ports.tasks.list({ kind: 'work' })) {
    await current();
    const entrusted = task.entrustedWork;
    if (task.userId !== ownerUserId || !task.ownerCatId || !entrusted) continue;
    const sourceRef = entrusted.admission.sourceRefs[0];
    if (!sourceRef?.startsWith('message:')) continue;
    let isCollective = task.subjectKey?.startsWith('collective-work:') ?? false;
    try {
      const source = await ports.messaging.get(sourceRef.slice('message:'.length));
      await current();
      if (source?.source?.connector !== 'collective') {
        if (isCollective) unavailableTaskIds.push(task.id);
        continue;
      }
      isCollective = true;
      const identity = collectiveSourceIdentitySchema.parse(source.source.meta?.participation);
      if (source.userId !== ownerUserId || identity.catId !== task.ownerCatId)
        throw new Error('Original source changed');
      const receipt = await readWorkStoredReceipt(ports.storage, ownerUserId, source.id, task.ownerCatId);
      await current();
      assertCollectiveWorkTask(task, source, task.ownerCatId, ports.pluginInstanceId, receipt?.binding, {
        allowTerminal: true,
        allowStaleController: true,
      });
      const work = receipt
        ? await connector.readAssignedWork(identity.connectionId, receipt.work.workId)
        : await connector.readAssignedWorkByAssignment(identity.connectionId, identity.eventId);
      await current();
      await connector.withAssignedWorkAuthority(identity.connectionId, work.workId, async (scope) => {
        await current();
        if (
          scope.hostRoute?.localOwnerUserId !== ownerUserId ||
          scope.connection.authorizedHumanId !== scope.work.accountableHumanId ||
          scope.work.assignment?.humanId !== scope.connection.authorizedHumanId ||
          scope.work.assignment?.catId !== task.ownerCatId ||
          scope.work.serviceInstanceId !== identity.serviceInstanceId ||
          scope.work.collectiveId !== identity.collectiveId ||
          scope.work.assignmentEventId !== (receipt?.work.assignmentEventId ?? identity.eventId)
        )
          throw new Error('Work is not this owner’s current assigned task');
        const latest = await ports.tasks.get({ id: task.id });
        await current();
        if (!isDeepStrictEqual(latest, task)) throw new Error('Original Task changed while reading dates');
        items.push(
          collectiveWorkCalendarItemSchema.parse({
            taskId: task.id,
            taskRevision: entrusted.revision,
            serviceInstanceId: scope.connection.serviceInstanceId,
            serviceUrl: scope.connection.serviceUrl,
            collectiveId: scope.connection.collectiveId,
            connectionId: scope.connection.connectionId,
            workId: work.workId,
            workRevision: scope.work.revision,
            location: scope.work.sourceLocation,
            time: scope.work.time ?? {},
          }),
        );
      });
    } catch {
      if (isCollective) unavailableTaskIds.push(task.id);
    }
  }
  await current();
  return { items, unavailableTaskIds };
}
