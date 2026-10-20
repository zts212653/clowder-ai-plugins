import { createHash } from 'node:crypto';
import type { CollectiveConnector } from './business/connector/connector.js';
import type { CollectiveArtifactCommand, CollectiveSourceIdentity } from './business/contracts/index.js';
import { collectiveContextError } from './collective-context-refs.js';

/** The authenticated current source selects the resource, never a supplied Human or connection. */
export async function executeCollectiveArtifactCommand(
  connector: Pick<CollectiveConnector, 'readArtifactContext' | 'requestArtifactForAgent'>,
  binding: {source: CollectiveSourceIdentity; displayName: string; revalidate(): Promise<void>},
  auth: {catId: string; invocationId: string}, command: CollectiveArtifactCommand,
) {
  await binding.revalidate();
  const context = await connector.readArtifactContext(binding.source);
  await binding.revalidate();
  const target = context.requests.find(item => item.artifactId === command.artifactId);
  if (context.status !== 'available' || !target)
    throw collectiveContextError('ARTIFACT_ACCESS_DENIED', 'This invocation source has no current shared work reference');
  const {artifactId: _artifactId, kind, ...payload} = command;
  const operation = command.kind === 'respond' ? command.operationId : payload;
  const requestId = `artifact-command:${createHash('sha256').update(JSON.stringify([
    binding.source.eventId, target.artifactId, kind, operation,
  ])).digest('hex')}`;
  const value = await connector.requestArtifactForAgent(binding.source,
    {catId: auth.catId, agentId: auth.catId, displayName: binding.displayName, sessionRef: auth.invocationId},
    {artifactId: target.artifactId, sourceEventId: target.sourceEventId, ownerRevision: target.ownerRevision,
      action: kind === 'respond' ? 'propose' : 'read', requestId,
      payload: kind === 'respond' ? {...payload, kind: 'respond-modification'} : payload});
  await binding.revalidate();
  return value;
}
