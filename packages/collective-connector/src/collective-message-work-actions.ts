import type {PluginActionContext} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import type {createCollectiveMessageWorkCaller} from './collective-message-work.js';
import type {openCollectiveContextReferences} from './collective-context-refs.js';
import {collectiveContextError} from './collective-context-refs.js';
import {publishCollectiveProgress} from './owner-work-progress.js';
import type {createCollectiveMessageWorkArtifacts} from './collective-message-work-artifacts.js';
import {collectiveWorkNativeTools} from './work-native-methods.js';

/** Same declared Work MCP methods over an ordinary Registry-authenticated call.
 * The original Connector owns reply preparation, replay and Service receipts. */
export function createCollectiveMessageWorkActions(connector: CollectiveConnector,
  caller: ReturnType<typeof createCollectiveMessageWorkCaller>,
  refs: Awaited<ReturnType<typeof openCollectiveContextReferences>>,
  artifacts: ReturnType<typeof createCollectiveMessageWorkArtifacts>) {
  return async (method: string, unsafe: unknown, action: PluginActionContext) => {
    const tool = collectiveWorkNativeTools.find(tool => tool.method === method);
    if (!tool) throw collectiveContextError('NOT_COLLECTIVE_ORIGIN', 'Unknown Work method');
    const input = tool.schema.parse(unsafe ?? {}) as Record<string, unknown>;
    return caller.withCurrentMessage(action, async binding => {
      const identity = {pluginInstanceId: binding.auth.source.extra.pluginMessage.instanceId, invocationId: binding.auth.invocationId};
      const current = () => binding.revalidate();
      const prepare = () => connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
        binding.work.revision, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      const currentReply = async () => {
        await current();let operation = await prepare();await current();
        if (operation.status === 'queued' || operation.status === 'sending') {
          await connector.sync(binding.source.connectionId);await current();operation = await prepare();await current();
        }
        const context = await connector.readParticipationContext(binding.source, 0, 1);await current();
        const artifactSelection = await artifacts.current(binding);
        return {artifactSelection, time: binding.time, kind: 'collective', authority: 'owner_admitted_work', actor: binding.source.actor,
          location: binding.source.location, participant: binding.displayName, request: context.source,
          workRef: {subjectRef: `task:${binding.resultKey}`, revision: binding.work.revision},
          contextRef: refs.opaqueRef(identity, 'context', binding.refScope),
          returnRef: refs.opaqueRef(identity, 'return', binding.refScope),
          replyOperationRef: refs.opaqueRef(identity, `reply:${operation.outboxId}`, binding.refScope),
          progressOperationRef: refs.opaqueRef(identity, 'progress', binding.refScope),
          reply: {status: operation.status, ...(operation.status === 'prepared' ? {} : {body: operation.body, author: operation.agent}),
            ...(operation.acceptedEventId ? {eventId: operation.acceptedEventId} : {}),
            ...(operation.failureCode ? {code: operation.failureCode} : {})}};
      };
      if (method === 'collective.work.context.current') return currentReply();
      if (method === 'collective.work.context.read') {
        refs.verifyRef(identity, input.contextRef as string, 'context', binding.refScope);await current();
        const source = await connector.readParticipationContext(binding.source, input.afterSequence as number ?? 0, input.limit as number ?? 30);
        const previousResultArtifact = await artifacts.readPrevious(connector, binding);await current();
        return {...source, ...(previousResultArtifact ? {previousResultArtifact} : {})};
      }
      if (method === 'collective.work.progress') {
        refs.verifyRef(identity, input.returnRef as string, 'return', binding.refScope);
        refs.verifyRef(identity, input.progressOperationRef as string, 'progress', binding.refScope);await current();
        const result = await publishCollectiveProgress(connector, binding.auth, binding, input.body as string);
        await current();return result;
      }
      if (method === 'collective.work.artifact.register') {
        refs.verifyRef(identity, input.contextRef as string, 'context', binding.refScope);await current();
        return artifacts.register(binding, input.expectedRevision as number, input.artifactRefs as string[]);
      }
      if (method === 'collective.work.artifact.read') {
        refs.verifyRef(identity, input.contextRef as string, 'context', binding.refScope);await current();
        const selected = await artifacts.readSelected(binding);await current();
        return selected ? {state: 'available', ...selected, trust: 'untrusted_external', instructionPolicy: 'data_only'} : {state: 'unavailable', code: 'NO_ARTIFACT'};
      }
      if (method === 'collective.work.reply.submit') {
        const operation = await prepare();await current();
        refs.verifyRef(identity, input.returnRef as string, 'return', binding.refScope);
        refs.verifyRef(identity, input.replyOperationRef as string, `reply:${operation.outboxId}`, binding.refScope);
        const selected = await artifacts.readSelected(binding);await current();
        if (operation.workPurpose?.artifactSnapshot && (!selected ||
          JSON.stringify(operation.workPurpose.artifactSnapshot) !== JSON.stringify(selected.snapshot)))
          throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'The selected result material changed');
        await current();
        await connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, operation.outboxId, input.body as string,
          {catId: binding.auth.catId, agentId: binding.auth.catId, displayName: binding.displayName, sessionRef: binding.auth.invocationId},
          selected?.snapshot, binding.work.resultRevision, {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
        await current();await connector.sync(binding.source.connectionId);await current();return currentReply();
      }
      throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Unknown Work method');
    });
  };
}
