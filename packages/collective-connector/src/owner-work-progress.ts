import type { CollectiveConnector } from './business/connector/index.js';
import type { CollectiveProgressPurpose } from './business/connector/work-progress-custody.js';

// Package-internal inputs to the original progress algorithm. A caller must first
// obtain the actual current private Task/Service binding; this is no Host/SDK port
// and does not construct admission or execution authority.
type ProgressBinding = Pick<CollectiveProgressPurpose, 'source' | 'sourceRef' | 'resultKey'> & {
  readonly displayName: string;
  readonly work: {
    readonly revision: CollectiveProgressPurpose['taskRevision'];
    readonly resultRevision: CollectiveProgressPurpose['resultRevision'];
    readonly executionRevision: CollectiveProgressPurpose['executionRevision'];
    readonly assignmentEventId: CollectiveProgressPurpose['assignmentEventId'];
  };
};

export async function publishCollectiveProgress(
  connector: Pick<CollectiveConnector, 'prepareProgress' | 'submitProgress' | 'sync' | 'listInbox'>,
  auth: { readonly catId: string; readonly invocationId: string },
  binding: ProgressBinding,
  body: string,
) {
  const purpose = {
    source: binding.source,
    sourceRef: binding.sourceRef,
    resultKey: binding.resultKey,
    taskRevision: binding.work.revision,
    resultRevision: binding.work.resultRevision,
    executionRevision: binding.work.executionRevision,
    assignmentEventId: binding.work.assignmentEventId,
    authorCatId: auth.catId,
    body,
  };
  const operation = await connector.prepareProgress(purpose);
  await connector.submitProgress(purpose, operation.outboxId, {
    catId: auth.catId,
    agentId: auth.catId,
    displayName: binding.displayName,
    sessionRef: auth.invocationId,
  });
  await connector.sync(binding.source.connectionId);
  const current = await connector.prepareProgress(purpose);
  const event = (await connector.listInbox(binding.source.connectionId)).find(
    (item) => item.event.eventId === current.acceptedEventId,
  )?.event;
  return {
    status: current.status,
    eventId: current.acceptedEventId,
    code: current.failureCode,
    receipt: event?.workProgressReceipt,
  };
}
