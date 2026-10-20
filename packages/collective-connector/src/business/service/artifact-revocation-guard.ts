import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

/** Keep the canonical owner reachable until custody and any admitted initial effect are settled. */
export function requireNoArtifactCustody(state: ServiceState, connectionId: string, allowRetainedContinuity = false) {
  const continuityInstalled =
    allowRetainedContinuity && Boolean(state.connections[connectionId]?.custodyRecoveryDigest);
  const holdsArtifact = Object.values(state.artifacts).some(
    (artifact) =>
      artifact.custody.connectionId === connectionId &&
      (!continuityInstalled || !['image/png', 'video/mp4'].includes(artifact.mediaType)),
  );
  const publishing = Object.values(state.artifactPublications).some(
    (publication) =>
      publication.connectionId === connectionId && publication.status === 'pending' && publication.effectPending,
  );
  if (holdsArtifact || publishing)
    throw new CollectiveServiceError(
      'ARTIFACT_CUSTODY_HANDOFF_REQUIRED',
      'Settle pending publications and hand off shared work custody before revoking this Café',
      409,
    );
}
