import type { ChangeCollectiveAgentWorkTimeRequest } from '../contracts/index.js';
import { changeCollectiveAgentWorkTimeRequestSchema } from '../contracts/index.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import type { VerifiedAgent } from './state.js';

type CommandWithoutIdentity<T> = T extends ChangeCollectiveAgentWorkTimeRequest
  ? Omit<T, 'serviceInstanceId' | 'collectiveId' | 'connectionId' | 'catId' | 'participationRevision'>
  : never;
export type AgentWorkTimeCommand = CommandWithoutIdentity<ChangeCollectiveAgentWorkTimeRequest>;

export async function changeVerifiedWorkTime(input: {
  readonly connectionId: string;
  readonly agent: VerifiedAgent;
  readonly command: AgentWorkTimeCommand;
  readonly persistence: ConnectorPersistence;
  readonly service: CollectiveServiceClient;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
}) {
  const before = input.persistence.snapshot().connections[input.connectionId];
  if (before?.authorityStatus !== 'connected' || !before.endpointCredential || !before.authorizedHumanId)
    throw new Error('Current connected source owner is required');
  if (!(await input.verifyAgent(input.agent))) throw new Error('The current authenticated Cat is required');
  const work = await input.service.readAssignedWork(before.serviceUrl, before.endpointCredential, {
    serviceInstanceId: before.serviceInstanceId,
    collectiveId: before.collectiveId,
    connectionId: before.connectionId,
    workId: input.command.workId,
  });
  if (
    work.assignment?.humanId !== before.authorizedHumanId ||
    work.assignment.catId !== input.agent.catId ||
    work.assignment.connectionId !== before.connectionId
  )
    throw new Error('This Cat does not execute the selected task');
  const command = changeCollectiveAgentWorkTimeRequestSchema.parse({
    ...input.command,
    serviceInstanceId: before.serviceInstanceId,
    collectiveId: before.collectiveId,
    connectionId: before.connectionId,
    catId: input.agent.catId,
    participationRevision: work.executionAuthority?.participationRevision ?? work.assignment.participationRevision,
  });
  if (!(await input.verifyAgent(input.agent))) throw new Error('Cat authority changed before the date command');
  const result = await input.service.changeAgentWorkTime(before.serviceUrl, before.endpointCredential, command);
  const after = input.persistence.snapshot().connections[input.connectionId];
  if (after?.authorityStatus !== 'connected' || after.endpointCredential !== before.endpointCredential)
    throw new Error('Connection changed while confirming the date command; retry the same operation');
  return result;
}
