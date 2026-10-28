import { CollectiveServiceError } from './errors.js';
import type { MutableServiceState, ServiceState } from './state.js';

export function collaborationOperationReplay(
  state: ServiceState,
  input: {
    collectiveId: string;
    actorScope: string;
    requestId: string;
    payload: unknown;
    resourceKind:
      | 'work'
      | 'roadmap'
      | 'vote'
      | 'binding_vote'
      | 'reaction'
      | 'artifact'
      | 'material'
      | 'project_artifact';
  },
) {
  const key = collaborationOperationKey(input.collectiveId, input.actorScope, input.requestId);
  const fingerprint = JSON.stringify(input.payload);
  const existing = state.collaborationOperations[key];
  if (!existing) return { key, fingerprint };
  if (existing.fingerprint !== fingerprint || existing.resourceKind !== input.resourceKind) {
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'requestId already names a different collaboration operation',
      409,
    );
  }
  return { key, fingerprint, existing };
}

export function recordCollaborationOperation(
  state: MutableServiceState,
  input: {
    key: string;
    fingerprint: string;
    actorScope: string;
    resourceKind:
      | 'work'
      | 'roadmap'
      | 'vote'
      | 'binding_vote'
      | 'reaction'
      | 'artifact'
      | 'material'
      | 'project_artifact';
    resourceId: string;
    revision: number;
    recordedAt: string;
  },
) {
  state.collaborationOperations[input.key] = {
    actorScope: input.actorScope,
    fingerprint: input.fingerprint,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    revision: input.revision,
    recordedAt: input.recordedAt,
  };
}

function collaborationOperationKey(collectiveId: string, actorScope: string, requestId: string): string {
  return JSON.stringify([collectiveId, actorScope, requestId]);
}
