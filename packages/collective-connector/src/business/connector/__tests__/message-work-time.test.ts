import { expect, test } from 'vitest';
import type { FeatureContext, PluginTaskReadItem } from '@clowder-ai/plugin-sdk';
import { fixture } from './communication-work-custody.fixture.js';
import { collectiveEventSourceIdentity } from '../../contracts/index.js';
import { collectiveSource } from '../../../collective-ingress-routing.js';
import { resolveHumanMessageWork } from '../../../collective-human-message-work.js';
import { readWorkFirstReceipt } from '../../../owner-work-first-receipt.js';

test('original standing Human source with a deadline still needs an explicit typed time fact before private execution', async () => {
  const f = await fixture({ body: 'Deliver the report by Friday.' });
  try {
    const coords = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
      ...coords,
      sourceEventId: f.source.eventId,
      requestId: 'time-proposal',
    });
    const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
      ...coords,
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      requestId: 'time-commit',
      assignment: {
        connectionId: f.connection.connectionId,
        catId: f.agent.catId,
        participationRevision: 1,
      },
    });
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    const key = `${f.owner.human.humanId}:${f.agent.catId}`;
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: route.localOwnerUserId,
        defaultIngressThreadId: route.defaultIngressThreadId,
        humanNotificationThreadId: route.humanNotificationThreadId,
        agentRoutes: {
          ...route.agentRoutes,
          [key]: {
            ...route.agentRoutes[key]!,
            standingWork: {
              requestingHumanIds: [f.owner.human.humanId],
              channelIds: ['general'],
              expiresAt: null,
            },
          },
        },
      },
      route.revision,
    );
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(
      (row) => row.event.eventId === work.assignmentEventId,
    )!;
    const source = collectiveEventSourceIdentity(item.event)!;
    const message = {
      id: 'time-source',
      threadId: 'channel',
      userId: 'local-owner',
      catId: null,
      content: item.event.body,
      timestamp: 1,
      sourceRevision: 'time-source-1',
      mentions: [],
      source: collectiveSource(item.event, source),
    };
    const currentRoute = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.beginInboxRouting(f.connection.connectionId, source.eventId, currentRoute.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, source.eventId, currentRoute.revision, {
      kind: 'thread_message',
      threadId: message.threadId,
      messageId: message.id,
      catId: source.catId,
    });
    let writes = 0;
    const entries = new Map<string, { revision: number; value: unknown }>();
    const storage = {
      get: async (key: string) => structuredClone(entries.get(key)),
      compareAndSet: async (key: string, expected: number | null, value: unknown) => {
        if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
        entries.set(key, { revision: ++writes, value: structuredClone(value) });
        return { applied: true, revision: writes };
      },
    } as unknown as FeatureContext['storage'];
    await expect(
      resolveHumanMessageWork(f.connector, storage, source, message, 'local-owner', async () => {}, {
        mode: 'send',
        hasTask: false,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_ADMISSION_UNAVAILABLE' });
    expect(writes).toBe(0);
    await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
      ...coords,
      workId: work.workId,
      expectedRevision: work.revision,
      requestId: 'confirm-public-deadline',
      action: 'set',
      field: 'businessDeadline',
      time: { value: '2026-10-30T15:59:00Z', timeZone: 'Asia/Shanghai' },
    });
    const admitted = await resolveHumanMessageWork(
      f.connector,
      storage,
      source,
      message,
      'local-owner',
      async () => {},
      { mode: 'send', hasTask: false },
    );
    expect(admitted.work.time?.businessDeadline?.actor).toMatchObject({
      kind: 'human',
      humanId: f.owner.human.humanId,
    });
    expect(writes).toBe(1);
  } finally {
    await f.close();
  }
});

test('current Service facts materialize the missing private receipt only after the old Host Task is owner-adopted', async () => {
  const f = await fixture({ body: 'Deliver the report.' });
  try {
    const coords = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
      ...coords,
      sourceEventId: f.source.eventId,
      requestId: 'legacy-proposal',
    });
    const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
      ...coords,
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      requestId: 'legacy-commit',
      assignment: { connectionId: f.connection.connectionId, catId: f.agent.catId, participationRevision: 1 },
    });
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!,
      key = `${f.owner.human.humanId}:${f.agent.catId}`;
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: route.localOwnerUserId,
        defaultIngressThreadId: route.defaultIngressThreadId,
        humanNotificationThreadId: route.humanNotificationThreadId,
        agentRoutes: {
          ...route.agentRoutes,
          [key]: {
            ...route.agentRoutes[key]!,
            standingWork: {
              requestingHumanIds: [f.owner.human.humanId],
              channelIds: ['general'],
              expiresAt: null,
            },
          },
        },
      },
      route.revision,
    );
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(
      (row) => row.event.eventId === work.assignmentEventId,
    )!;
    const source = collectiveEventSourceIdentity(item.event)!;
    const message = {
      id: 'legacy-source',
      threadId: 'channel',
      userId: 'local-owner',
      catId: null,
      content: item.event.body,
      timestamp: 1,
      sourceRevision: 'legacy-source-1',
      mentions: [],
      source: collectiveSource(item.event, source),
    };
    const currentRoute = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.beginInboxRouting(f.connection.connectionId, source.eventId, currentRoute.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, source.eventId, currentRoute.revision, {
      kind: 'thread_message',
      threadId: message.threadId,
      messageId: message.id,
      catId: source.catId,
    });
    let writes = 0;
    const entries = new Map<string, { revision: number; value: unknown }>();
    const storage = {
      get: async (key: string) => structuredClone(entries.get(key)),
      compareAndSet: async (key: string, expected: number | null, value: unknown) => {
        if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
        entries.set(key, { revision: ++writes, value: structuredClone(value) });
        return { applied: true, revision: writes };
      },
    } as unknown as FeatureContext['storage'];
    const controllerReceipt = `task-data-controller:${'a'.repeat(64)}`;
    const legacyTask: PluginTaskReadItem = {
      id: 'legacy-task',
      userId: 'local-owner',
      kind: 'work',
      threadId: 'private',
      subjectKey: 'entrusted:legacy',
      title: 'Original Work',
      ownerCatId: source.catId,
      status: 'todo',
      why: 'Deliver it',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 1,
      entrustedWork: {
        revision: 3,
        artifactRefs: [],
        closure: { state: 'open' },
        admission: {
          sourceRefs: [`message:${message.id}`],
          authorityRef: 'message:legacy-host-receipt',
          hostReceipt: {
            receiptRef: 'message:legacy-host-receipt',
            sourceRef: `message:${message.id}`,
            catId: source.catId,
          },
        },
      },
    };
    await expect(
      resolveHumanMessageWork(f.connector, storage, source, message, 'local-owner', async () => {}, {
        mode: 'send',
        hasTask: true,
        existingTask: legacyTask,
        pluginInstanceId: 'installed',
      }),
    ).rejects.toMatchObject({ code: 'OWNER_ADOPTION_REQUIRED' });
    expect(writes).toBe(0);
    const existingTask: PluginTaskReadItem = {
      ...legacyTask,
      entrustedWork: {
        ...legacyTask.entrustedWork!,
        dataController: {
          bindingRevision: 1,
          state: 'active',
          currentForCaller: true,
          binding: {
            userId: 'local-owner',
            catId: source.catId,
            threadId: 'private',
            subjectKey: 'entrusted:legacy',
            firstSourceRef: `message:${message.id}`,
            admissionAuthorityRef: 'message:legacy-host-receipt',
            pluginId: 'official.collective-connector',
            pluginInstanceId: 'installed',
            moduleRef: 'plugin:official.collective-connector',
            lifecycleRevision: 8,
            ownerOperationReceiptRef: controllerReceipt,
          },
        },
      },
    };
    const result = await resolveHumanMessageWork(f.connector, storage, source, message, 'local-owner', async () => {}, {
      mode: 'send',
      hasTask: true,
      existingTask,
      pluginInstanceId: 'installed',
    });
    expect(result.work.workId).toBe(work.workId);
    expect(result.binding?.taskRef).toBe('task:work:legacy-task');
    expect(result.binding?.dataControllerReceiptRef).toBe(controllerReceipt);
    expect(writes).toBe(1);
    expect((await readWorkFirstReceipt(storage, 'local-owner', message.id, source.catId))?.work.workId).toBe(
      work.workId,
    );
  } finally {
    await f.close();
  }
});
