import { requireArtifactAction } from './artifact-authority.js';
import { requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { canReadLinkedParticipationSource } from './participation-store.js';
import type { ServiceState } from './state.js';

/** Public pin locators grant no body, annotation, adoption or project-replacement capability.
 * The existing Artifact tools still require their original explicit request delegation. */
export function projectParticipantArtifactReferences(
  state: ServiceState,
  credential: string,
  input: {
    collectiveId: string;
    serviceInstanceId: string;
    connectionId: string;
    catId: string;
  },
  roadmapId: string,
) {
  const connection = requireConnection(state, credential, input.connectionId),
    human = requireAuthorizedHuman(state, connection);
  const references = Object.values(state.projectArtifactReferences).flatMap((reference) => {
    if (
      reference.status !== 'active' ||
      reference.collectiveId !== input.collectiveId ||
      reference.roadmapId !== roadmapId
    )
      return [];
    const artifact = state.artifacts[reference.artifactId];
    if (!artifact || !canReadLinkedParticipationSource(state, credential, input, artifact.sourceEventId)) return [];
    try {
      requireArtifactAction(state, artifact, human.humanId, 'read');
    } catch {
      return [];
    }
    return [
      {
        referenceId: reference.referenceId,
        artifactId: artifact.artifactId,
        sourceEventId: artifact.sourceEventId,
        revision: reference.revision,
        versionRef: structuredClone(reference.versionRef),
      },
    ];
  });
  return { artifactReferences: references.slice(0, 30), artifactReferencesHaveMore: references.length > 30 };
}
