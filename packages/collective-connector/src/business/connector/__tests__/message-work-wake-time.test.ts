import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectiveMessageWorkActions } from '../../../collective-message-work-actions.js';
import { createCollectiveMessageWorkArtifacts } from '../../../collective-message-work-artifacts.js';
import { createCollectiveMessageWorkMaterials } from '../../../collective-message-work-materials.js';
import { assertCurrentWorkWake } from '../../../collective-work-wake.js';
import { setup } from './message-work-roundtrip.fixture.js';

async function resumedWork() {
  const f = await setup('human-manual');
  const originalGet = f.context.messaging.get.bind(f.context.messaging);
  const messages = new Map<string, Awaited<ReturnType<typeof originalGet>>>();
  vi.spyOn(f.context.messaging, 'get').mockImplementation(async id => messages.get(id) ?? originalGet(id));
  vi.spyOn(f.context.messaging, 'send').mockImplementation(async (threadId, draft) => {
    const messageId = 'resumed-private-source';
    messages.set(messageId, {
      id: messageId, threadId, userId: f.auth.userId, catId: null,
      content: (draft.payload.elements[0]!.payload as {text: string}).text,
      source: {connector: 'collective', label: 'Collective', icon: 'collective', meta: draft.meta},
      mentions: [], timestamp: 5, sourceRevision: 'resumed-source-revision',
    });
    return {messageId, threadId};
  });
  await f.store.postHumanMessage(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
    clientEventId: 'continue-original-dates', location: {channelId: 'general'},
    recipient: {kind: 'channel'}, replyToEventId: f.work.assignmentEventId,
    body: 'Continue the same task; give an execution estimate and keep my deadline.',
  });
  await f.connector.sync(f.connection.connectionId);
  const wake = (await f.connector.listInbox(f.connection.connectionId))
    .find(row => row.event.workWakeNotice?.workId === f.work.workId)!.event;
  const sent = await f.caller.wake(f.connection.connectionId, wake.eventId, f.auth.userId, async () => {});
  const action = {...f.action, originTriggerMessageId: sent.messageId};
  const refs = await openCollectiveContextReferences(join(f.root, 'wake-time-refs'), () => {});
  const invoke = createCollectiveMessageWorkActions(f.connector, f.caller, refs,
    createCollectiveMessageWorkArtifacts(f.context, createCollectiveMessageWorkMaterials(f.connector, f.context, () => {})));
  const contextRef = await f.caller.withCurrentMessage(action, async binding =>
    refs.opaqueRef({pluginInstanceId: f.context.pluginInstanceId, invocationId: action.invocationId},
      'context', binding.refScope));
  return {...f, wake, action, contextRef, invoke: (method: string, input: unknown) => invoke(method, input, action)};
}

test('a resumed Work returns its date CAS receipt, replays once and retains the same current execution', async () => {
  const f = await resumedWork();
  try {
    const before = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    const command = {contextRef: f.contextRef, requestId: 'resumed-plan', expectedWorkRevision: before.revision,
      command: {action: 'set', field: 'plannedStart',
        time: {value: '2026-11-02T09:00:00-08:00', timeZone: 'America/Los_Angeles'}}};
    const receipt = await f.invoke('collective.work.time', command);
    expect(receipt).toMatchObject({workId: f.work.workId, workRevision: before.revision + 1,
      time: {plannedStart: {actor: {kind: 'agent', catId: f.auth.catId}}}});
    expect(await f.invoke('collective.work.time', command)).toEqual(receipt);
    await expect(f.invoke('collective.work.time', {...command, requestId: 'stale-distinct-operation'}))
      .rejects.toThrow();
    const after = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(after.history.filter(entry => entry.action === 'time_changed')).toHaveLength(1);
    expect(after.time?.businessDeadline).toEqual(before.time?.businessDeadline);
    expect(await f.caller.withCurrentMessage(f.action, async binding => binding.work.workId)).toBe(f.work.workId);
    expect(await f.caller.withCurrentMessage(f.action, async binding => binding.work.revision)).toBe(1);
    expect(f.task.entrustedWork?.time).toEqual({});
    expect(() => assertCurrentWorkWake(f.wake, after)).toThrow();
    expect(() => assertCurrentWorkWake(f.wake, after, 'execution')).not.toThrow();
    for (const changed of [
      {...f.wake, workWakeNotice: {...f.wake.workWakeNotice!, workRevision: after.revision + 1}},
      {...f.wake, workWakeNotice: {...f.wake.workWakeNotice!, executionRevision: 2}},
      {...f.wake, workWakeNotice: {...f.wake.workWakeNotice!, assignmentEventId: 'evt_other_assignment'}},
    ]) expect(() => assertCurrentWorkWake(changed, after, 'execution')).toThrow();
    await expect(f.caller.wake(f.connection.connectionId, f.wake.eventId, f.auth.userId, async () => {}))
      .rejects.toMatchObject({code: 'COLLECTIVE_WORK_WAKE_NOT_CURRENT'});
    Object.assign(f.task, {status: 'done'});
    await expect(f.invoke('collective.work.time', command)).rejects.toThrow();
  } finally {vi.restoreAllMocks(); await f.close();}
});

test('a resumed Work reports progress once and observes actual start without cancelling its own native receipt', async () => {
  const f = await resumedWork();
  try {
    const context = z.object({returnRef: z.string(), progressOperationRef: z.string()}).passthrough()
      .parse(await f.invoke('collective.work.context.current', {}));
    const input = {returnRef: context.returnRef, progressOperationRef: context.progressOperationRef,
      body: 'Read the original material and began the same entrusted work.'};
    const receipt = z.object({status: z.string(), eventId: z.string()}).passthrough()
      .parse(await f.invoke('collective.work.progress', input));
    expect(await f.invoke('collective.work.progress', input)).toEqual(receipt);
    const after = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(after.lifecycle).toBe('in_progress');
    expect(after.time?.actualStart?.actor).toMatchObject({kind: 'agent', catId: f.auth.catId});
    expect(after.history.filter(entry => entry.action === 'progress_reported')).toHaveLength(1);
    await f.connector.revoke(f.connection.connectionId);
    await expect(f.invoke('collective.work.progress', input)).rejects.toThrow();
  } finally {vi.restoreAllMocks(); await f.close();}
});
