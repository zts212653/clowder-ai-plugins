import type { ChangeCollectiveAgentWorkTimeRequest, CollectiveSourceIdentity } from '../contracts/index.js';
import type { CollectiveMaterialSuggestionRequest } from '../contracts/types/collective-project-source.js';

type SourceKeys =
  | 'serviceInstanceId'
  | 'collectiveId'
  | 'connectionId'
  | 'sourceEventId'
  | 'catId'
  | 'participationRevision';
export type MaterialSuggestion = Omit<CollectiveMaterialSuggestionRequest, SourceKeys>;
export type PublicDateSuggestion = Omit<
  Extract<ChangeCollectiveAgentWorkTimeRequest, { action: 'suggest' }>,
  SourceKeys | 'action'
>;
export function projectSourceRequest(source: CollectiveSourceIdentity) {
  return {
    serviceInstanceId: source.serviceInstanceId,
    collectiveId: source.collectiveId,
    connectionId: source.connectionId,
    sourceEventId: source.eventId,
    catId: source.catId,
    participationRevision: source.participationRevision,
  };
}
