import type { CollectiveMembershipLeaveReadiness } from '../contracts/index.js';
import { requireArtifactAction } from './artifact-authority.js';
import { projectCollectiveWork } from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { ServiceState } from './state.js';

const terminalWork = new Set(['completed', 'declined', 'cancelled']);

const byCreated = <Record extends { readonly createdAt: string }>(left: Record, right: Record) =>
  left.createdAt.localeCompare(right.createdAt);

export function readMembershipLeaveReadiness(
  state: ServiceState,
  sessionToken: string,
  collectiveId: string,
): CollectiveMembershipLeaveReadiness {
  const { human } = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  if (!state.collectives[collectiveId]) {
    throw new CollectiveServiceError('COLLECTIVE_NOT_FOUND', 'Collective was not found', 404);
  }
  requireMembership(state, collectiveId, human.humanId);
  return projectMembershipLeaveReadiness(state, collectiveId, human.humanId);
}

export function projectMembershipLeaveReadiness(
  state: ServiceState,
  collectiveId: string,
  humanId: string,
): CollectiveMembershipLeaveReadiness {
  const membership = requireMembership(state, collectiveId, humanId);
  const roadmaps = Object.values(state.roadmaps)
    .filter(
      (roadmap) =>
        roadmap.collectiveId === collectiveId && roadmap.accountableHumanId === humanId && roadmap.status === 'active',
    )
    .sort(byCreated);
  const allRoadmaps = Object.values(state.roadmaps)
    .filter((roadmap) => roadmap.collectiveId === collectiveId)
    .sort(byCreated);
  const roadmapsByWork = new Map<string, typeof allRoadmaps>();
  for (const roadmap of allRoadmaps) {
    for (const workId of roadmap.workIds) {
      const workRoadmaps = roadmapsByWork.get(workId) ?? [];
      workRoadmaps.push(roadmap);
      roadmapsByWork.set(workId, workRoadmaps);
    }
  }
  const works = Object.values(state.works)
    .filter(
      (work) =>
        work.collectiveId === collectiveId && work.accountableHumanId === humanId && !terminalWork.has(work.lifecycle),
    )
    .sort(byCreated)
    .map((work) => {
      const projection = projectCollectiveWork(state, work);
      return {
        workId: work.workId,
        title: work.title,
        lifecycle: work.lifecycle,
        status: projection.status,
        source: { eventId: work.sourceEventId, location: structuredClone(work.sourceLocation) },
        projects: (roadmapsByWork.get(work.workId) ?? []).map((roadmap) => ({
          roadmapId: roadmap.roadmapId,
          title: roadmap.title,
          source: { eventId: roadmap.sourceEventId, location: structuredClone(roadmap.sourceLocation) },
        })),
      };
    });
  const connectionIds = new Set(
    Object.values(state.connections)
      .filter((connection) => connection.collectiveId === collectiveId && connection.authorizedHumanId === humanId)
      .map((connection) => connection.connectionId),
  );
  const artifacts: CollectiveMembershipLeaveReadiness['responsibilities']['artifacts']['items'] = [];
  let inaccessibleCount = 0;
  for (const artifact of Object.values(state.artifacts).filter(
    (candidate) => candidate.collectiveId === collectiveId && connectionIds.has(candidate.custody.connectionId),
  )) {
    try {
      requireArtifactAction(state, artifact, humanId, 'read');
      const head = artifact.versions.at(-1);
      if (!head) throw new CollectiveServiceError('STATE_CORRUPT', 'Artifact has no current version', 500);
      artifacts.push({
        kind: 'artifact',
        artifactId: artifact.artifactId,
        title: artifact.title,
        mediaType: artifact.mediaType,
        ownerRevision: head.ownerRevision,
        source: { eventId: artifact.sourceEventId, location: structuredClone(artifact.sourceLocation) },
        ...(artifact.workId ? { workId: artifact.workId } : {}),
      });
    } catch (error) {
      if (!(error instanceof CollectiveServiceError) || !['ARTIFACT_ACCESS_DENIED', 'FORBIDDEN'].includes(error.code)) {
        throw error;
      }
      inaccessibleCount += 1;
    }
  }
  for (const publication of Object.values(state.artifactPublications).filter(
    (candidate) =>
      candidate.collectiveId === collectiveId &&
      connectionIds.has(candidate.connectionId) &&
      candidate.status === 'pending' &&
      candidate.effectPending,
  )) {
    if (publication.humanId !== humanId) {
      inaccessibleCount += 1;
      continue;
    }
    artifacts.push({
      kind: 'publication',
      publicationId: publication.publicationId,
      title: publication.title,
      source: { eventId: publication.sourceEventId, location: structuredClone(publication.sourceLocation) },
      ...(publication.workId ? { workId: publication.workId } : {}),
    });
  }
  artifacts.sort((left, right) => {
    const leftId = left.kind === 'artifact' ? left.artifactId : left.publicationId;
    const rightId = right.kind === 'artifact' ? right.artifactId : right.publicationId;
    return leftId.localeCompare(rightId);
  });
  const responsibilities = {
    works,
    roadmaps: roadmaps.map((roadmap) => ({
      roadmapId: roadmap.roadmapId,
      title: roadmap.title,
      source: { eventId: roadmap.sourceEventId, location: structuredClone(roadmap.sourceLocation) },
    })),
    artifacts: { items: artifacts, inaccessibleCount },
  };
  const governanceHandoffRequired = membership.role === 'steward';
  const canLeave =
    !governanceHandoffRequired &&
    responsibilities.works.length === 0 &&
    responsibilities.roadmaps.length === 0 &&
    responsibilities.artifacts.items.length === 0 &&
    responsibilities.artifacts.inaccessibleCount === 0;
  return {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId,
    role: membership.role,
    membershipRevision: membership.revision,
    governanceHandoffRequired,
    canLeave,
    responsibilities,
  };
}
