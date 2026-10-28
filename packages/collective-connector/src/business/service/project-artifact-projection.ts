import type {
  CollectiveProjectArtifactItem,
  CollectiveProjectArtifactReference,
  CollectiveProjectArtifactVersionRef,
} from '../contracts/index.js';
import { artifactCustodianAvailable, projectArtifact, requireArtifactAction } from './artifact-authority.js';
import { requireRoadmap, requireWorkSource } from './collaboration-command-helpers.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

export function sameProjectArtifactVersion(
  a: CollectiveProjectArtifactVersionRef,
  b: CollectiveProjectArtifactVersionRef,
) {
  return a.ownerRevision === b.ownerRevision && a.blobDigest === b.blobDigest && a.receiptRef === b.receiptRef;
}

/** Collective projects are published Channel sources. A recipient is conversational direction, not a privacy ACL.
 * Callers first authenticate membership of this exact Collective; private Café projects never enter this directory. */
export function requireReadableArtifactProject(state: ServiceState, collectiveId: string, roadmapId: string) {
  const project = requireRoadmap(state, collectiveId, roadmapId);
  requireWorkSource(state, collectiveId, project.sourceEventId);
  return project;
}

export function projectArtifactReference(
  state: ServiceState,
  reference: CollectiveProjectArtifactReference,
  humanId: string,
  ownerFailure?: Exclude<CollectiveProjectArtifactItem['availability'], 'available'>,
): CollectiveProjectArtifactItem {
  const unavailable = (
    availability: Exclude<CollectiveProjectArtifactItem['availability'], 'available'>,
  ): CollectiveProjectArtifactItem => ({
    reference: structuredClone(reference),
    availability,
    hasUpdate: false,
    usedBy: [],
  });
  const artifact = state.artifacts[reference.artifactId];
  if (!artifact || artifact.collectiveId !== reference.collectiveId) return unavailable('version_unavailable');
  try {
    requireArtifactAction(state, artifact, humanId, 'read');
  } catch (error) {
    if (error instanceof CollectiveServiceError) return unavailable('access_denied');
    throw error;
  }
  if (ownerFailure) return unavailable(ownerFailure);
  if (!artifactCustodianAvailable(state, artifact)) return unavailable('owner_unavailable');
  if (!artifact.versions.some((version) => sameProjectArtifactVersion(version, reference.versionRef)))
    return unavailable('version_unavailable');
  const latest = artifact.versions.at(-1)!;
  const usedBy = Object.values(state.projectArtifactReferences).flatMap((candidate) => {
    if (
      candidate.status !== 'active' ||
      candidate.collectiveId !== reference.collectiveId ||
      candidate.artifactId !== reference.artifactId
    )
      return [];
    try {
      const project = requireReadableArtifactProject(state, candidate.collectiveId, candidate.roadmapId);
      return [
        {
          roadmapId: project.roadmapId,
          title: project.title,
          accountableHumanId: project.accountableHumanId,
          versionRef: structuredClone(candidate.versionRef),
        },
      ];
    } catch (error) {
      if (error instanceof CollectiveServiceError) return [];
      throw error;
    }
  });
  return {
    reference: structuredClone(reference),
    availability: 'available',
    artifact: projectArtifact(state, artifact, humanId),
    latestVersionRef: {
      ownerRevision: latest.ownerRevision,
      blobDigest: latest.blobDigest,
      receiptRef: latest.receiptRef,
    },
    hasUpdate:
      latest.ownerRevision > reference.versionRef.ownerRevision &&
      (!reference.keptVersionRef || !sameProjectArtifactVersion(latest, reference.keptVersionRef)),
    usedBy,
  };
}
