import { createHash } from 'node:crypto';
import {
  COLLECTIVE_MEDIA_CUSTODY_PROOF_CONTEXT,
  type CollectiveArtifactRecord,
  recoverCollectiveMediaCustodySchema,
} from '../contracts/index.js';
import { denyArtifact, projectArtifact, requireArtifactAction } from './artifact-authority.js';
import { artifactIdentity } from './artifact-registration.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { digestSecret, type PersistentServiceState, secretMatches } from './persistence.js';
import type { ServiceState } from './state.js';

/** Same Host/Human recovery, not transfer: fresh retained sharing plus possession of the retired source secret. */
export async function recoverMediaCustody(
  persistence: PersistentServiceState,
  now: () => number,
  credential: string,
  unsafe: unknown,
) {
  const input = recoverCollectiveMediaCustodySchema.parse(unsafe);
  return persistence.transaction((state) => {
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    const human = requireAuthorizedHuman(state, connection);
    if (!['image/png', 'video/mp4'].includes(input.mediaType)) denyArtifact();
    const proof = createHash('sha256')
      .update(COLLECTIVE_MEDIA_CUSTODY_PROOF_CONTEXT)
      .update('\0')
      .update(credential)
      .digest('hex');
    state.connections[connection.connectionId] = { ...connection, custodyRecoveryDigest: digestSecret(proof) };
    const artifactId = artifactIdentity(input.serviceInstanceId, input.collectiveId, input.contentRef);
    const artifact = state.artifacts[artifactId];
    if (!artifact) return { status: 'new' as const };
    requireArtifactAction(state, artifact, human.humanId, 'read');
    const { previousConnectionId, previousCustodyProof, ...registration } = input;
    const operation = collaborationOperationReplay(state, {
      ...input,
      actorScope: `media-custody:${connection.connectionId}`,
      payload: registration,
      resourceKind: 'artifact',
    });
    if (operation.existing)
      return { status: 'rebound' as const, artifact: projectArtifact(state, artifact, human.humanId) };
    if (artifact.custody.connectionId === connection.connectionId) return { status: 'current' as const };
    const previous = requireRetiredMediaSource(state, artifact, human.humanId, input.collectiveId);
    requireSameRetainedVersion(artifact, input);
    if (!previousCustodyProof && !previousConnectionId)
      return { status: 'proof_required' as const, previousConnectionId: previous.connectionId };
    if (
      previousConnectionId !== previous.connectionId ||
      !previousCustodyProof ||
      !previous.custodyRecoveryDigest ||
      !secretMatches(previousCustodyProof, previous.custodyRecoveryDigest)
    )
      denyArtifact();
    const at = new Date(now()).toISOString();
    const rebound = {
      ...artifact,
      revision: artifact.revision + 1,
      updatedAt: at,
      // The canonical retained owner and ledger scope stay identical; only the revoked transport is repaired.
      // Fence every former decision/ref, including members with implicit read access.
      custody: { ...artifact.custody, connectionId: connection.connectionId, endpointId: connection.endpointId },
      access: Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(artifact.access),
            ...Object.values(state.memberships)
              .filter((member) => member.collectiveId === artifact.collectiveId)
              .map((member) => member.humanId),
          ]),
        ].map((id) => {
          const access = artifact.access[id] ?? { revision: 1, status: 'active' as const, mayApply: false };
          return [id, { ...access, revision: access.revision + 1 }];
        }),
      ),
    };
    state.artifacts[artifactId] = rebound;
    // Only canonical registration metadata enters the operation log, never the historical secret.
    recordCollaborationOperation(state, {
      ...operation,
      actorScope: `media-custody:${connection.connectionId}`,
      resourceKind: 'artifact',
      resourceId: artifactId,
      revision: rebound.custody.revision,
      recordedAt: at,
    });
    return { status: 'rebound' as const, artifact: projectArtifact(state, rebound, human.humanId) };
  });
}

function requireSameRetainedVersion(
  artifact: CollectiveArtifactRecord,
  input: ReturnType<typeof recoverCollectiveMediaCustodySchema.parse>,
) {
  const head = artifact.versions.at(-1);
  if (
    artifact.mediaType !== input.mediaType ||
    artifact.sourceEventId !== input.sourceEventId ||
    artifact.workId !== input.workId ||
    head?.ownerRevision !== input.ownerRevision ||
    head.blobDigest !== input.blobDigest ||
    head.receiptRef !== input.receiptRef
  )
    throw new CollectiveServiceError(
      'ARTIFACT_REVISION_CONFLICT',
      'Explicitly re-share the exact retained public version first',
      409,
    );
}

function requireRetiredMediaSource(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  humanId: string,
  collectiveId: string,
) {
  const previous = state.connections[artifact.custody.connectionId];
  if (
    !previous ||
    previous.status !== 'revoked' ||
    previous.authorizedHumanId !== humanId ||
    previous.collectiveId !== collectiveId ||
    previous.endpointId !== artifact.custody.endpointId ||
    artifact.pendingHandoff ||
    artifact.custody.status !== 'active'
  )
    denyArtifact();
  return previous;
}
