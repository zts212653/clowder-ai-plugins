import {
  type CollectiveArtifactRecord,
  revokeCollectiveArtifactAccessSchema,
  updateCollectiveArtifactAccessSchema,
} from '../contracts/index.js';
import {
  artifactAccess,
  projectArtifact,
  requireArtifact,
  requireArtifactHuman,
  requireArtifactManager,
} from './artifact-authority.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './membership-authority.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

export class CollectiveArtifactAccess {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}
  revoke(sessionToken: string, unsafeInput: unknown) {
    const input = revokeCollectiveArtifactAccessSchema.parse(unsafeInput);
    return this.update(sessionToken, { ...input, access: 'revoked' });
  }
  async update(sessionToken: string, unsafeInput: unknown) {
    const input = updateCollectiveArtifactAccessSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
      const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
      const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
      requireArtifactManager(state, artifact, human.humanId);
      const operation = collaborationOperationReplay(state, {
        ...input,
        actorScope: `human:${human.humanId}`,
        payload: input,
        resourceKind: 'artifact',
      });
      if (operation.existing) return projectArtifact(state, artifact, human.humanId);
      requireMembership(state, input.collectiveId, input.humanId);
      const access = artifactAccess(artifact, input.humanId);
      if (access.revision !== input.expectedAccessRevision)
        throw new CollectiveServiceError(
          'ARTIFACT_REVISION_CONFLICT',
          'This member access changed; refresh before retrying',
          409,
        );
      const updated = {
        ...artifact,
        // Read <-> apply edits preserve this delegation's read/propose actions. Revocation never carries it forward.
        requestSources:
          access.status === 'active' && input.access !== 'revoked'
            ? advanceLiveRequestAccess(state, artifact, input.humanId, access.revision)
            : artifact.requestSources,
        access: {
          ...artifact.access,
          [input.humanId]: {
            revision: access.revision + 1,
            status: input.access === 'revoked' ? ('revoked' as const) : ('active' as const),
            mayApply: input.access === 'apply',
          },
        },
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.artifacts[artifact.artifactId] = updated;
      recordCollaborationOperation(state, {
        ...operation,
        actorScope: `human:${human.humanId}`,
        resourceKind: 'artifact',
        resourceId: artifact.artifactId,
        revision: updated.access[input.humanId].revision,
        recordedAt: updated.updatedAt,
      });
      return projectArtifact(state, updated, human.humanId);
    });
  }
}

/** Carry only currently live access edges; stale/revoked/custody-fenced sources can never catch up later. */
function advanceLiveRequestAccess(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  humanId: string,
  previousRevision: number,
) {
  const targets = new Set(
    (state.events[artifact.collectiveId] ?? []).flatMap((event) =>
      event.recipient?.kind === 'agent' && event.recipient.humanId === humanId ? [event.eventId] : [],
    ),
  );
  return Object.fromEntries(
    Object.entries(artifact.requestSources).map(([id, source]) => [
      id,
      {
        ...source,
        ...(source.requestingHumanId === humanId && source.requesterAccessRevision === previousRevision
          ? { requesterAccessRevision: previousRevision + 1 }
          : {}),
        ...(targets.has(source.requestEventId) && source.targetAccessRevision === previousRevision
          ? { targetAccessRevision: previousRevision + 1 }
          : {}),
      },
    ]),
  );
}
