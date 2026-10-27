import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { FeatureContext, PluginTaskReadItem } from '@clowder-ai/plugin-sdk';
import { fixture } from './communication-work-custody.fixture.js';
import { collectiveEventSourceIdentity } from '../../contracts/index.js';
import { collectiveSource } from '../../../collective-ingress-routing.js';
import { readCollectiveWorkCalendarSource } from '../../../work-calendar-source.js';

it('reads current public dates onto the original owner Task without writing or exposing another family', async () => {
  const f = await fixture();
  try {
    const coords = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const proposal = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
      ...coords,
      requestId: 'calendar-propose',
      sourceEventId: f.source.eventId,
    });
    const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
      ...coords,
      requestId: 'calendar-commit',
      workId: proposal.workId,
      expectedRevision: proposal.revision,
      assignment: { connectionId: f.connection.connectionId, catId: f.agent.catId, participationRevision: 1 },
    });
    const time = { value: '2026-10-30T15:59:00Z', timeZone: 'Asia/Shanghai' };
    const changed = await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
      ...coords,
      workId: work.workId,
      requestId: 'calendar-deadline',
      expectedRevision: work.revision,
      action: 'set',
      field: 'businessDeadline',
      time,
    });
    await f.connector.sync(f.connection.connectionId);
    const event = (await f.connector.listInbox(f.connection.connectionId)).find(
      (item) => item.event.eventId === work.assignmentEventId,
    )!.event;
    const identity = collectiveEventSourceIdentity(event)!;
    const message = {
      id: 'calendar-source',
      userId: 'local-owner',
      threadId: 'channel',
      catId: null,
      content: event.body,
      timestamp: 1,
      sourceRevision: '1',
      source: collectiveSource(event, identity),
    };
    const subjectKey = `collective-work:${f.connection.connectionId}:${work.workId}`;
    const task: PluginTaskReadItem = {
      id: 'original-task',
      userId: 'local-owner',
      ownerCatId: f.agent.catId,
      threadId: 'private-work',
      subjectKey,
      kind: 'work',
      status: 'doing',
      title: 'Original task',
      why: 'Original outcome',
      createdBy: 'plugin',
      createdAt: 1,
      updatedAt: 2,
      entrustedWork: {
        revision: 3,
        artifactRefs: [],
        closure: { state: 'open' },
        admission: {
          sourceRefs: [`message:${message.id}`],
          authorityRef: `plugin-task-data:${createHash('sha256')
            .update(JSON.stringify(['installed', subjectKey]))
            .digest('hex')}`,
        },
      },
    };
    const writes = vi.fn();
    const context = {
      pluginInstanceId: 'installed',
      tasks: { list: async () => [task], get: async () => task, create: writes, update: writes },
      messaging: { get: async () => message },
      storage: { get: async () => undefined },
    } as unknown as Pick<FeatureContext, 'pluginInstanceId' | 'tasks' | 'messaging' | 'storage'>;
    const result = await readCollectiveWorkCalendarSource(f.connector, context, 'local-owner');
    expect(result.items).toMatchObject([
      {
        taskId: task.id,
        taskRevision: 3,
        workId: work.workId,
        workRevision: changed.revision,
        time: { businessDeadline: time },
      },
    ]);
    expect(writes).not.toHaveBeenCalled();
    expect((await readCollectiveWorkCalendarSource(f.connector, context, 'another-owner')).items).toEqual([]);
    await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
      ...coords,
      requestId: 'calendar-clear',
      workId: work.workId,
      expectedRevision: changed.revision,
      action: 'set',
      field: 'businessDeadline',
      time: null,
    });
    expect((await readCollectiveWorkCalendarSource(f.connector, context, 'local-owner')).items[0].time).toEqual({});
    await f.connector.revoke(f.connection.connectionId);
    const revoked = await readCollectiveWorkCalendarSource(f.connector, context, 'local-owner');
    expect(revoked.items).toEqual([]);
    expect(revoked.unavailableTaskIds).toContain(task.id);
  } finally {
    await f.close();
  }
});
