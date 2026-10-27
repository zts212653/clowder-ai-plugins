import type {
  CollectiveMaterialPublication,
  CollectiveMaterialRecord,
} from '../contracts/types/collective-material.js';
import { requireRoadmap, requireWorkSource } from './collaboration-command-helpers.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership } from './identity-store.js';
import type { ServiceState } from './state.js';

export function requireMaterial(
  state: ServiceState,
  collectiveId: string,
  materialId: string,
): CollectiveMaterialRecord {
  const material = state.materials[materialId];
  if (!material || material.collectiveId !== collectiveId)
    throw new CollectiveServiceError('MATERIAL_NOT_FOUND', 'Project material is unavailable', 404);
  return material;
}

/** A private source is usable only through its exact public event and still-current publishing owner. */
export function authorizeMaterialPublication(state: ServiceState, publication: CollectiveMaterialPublication) {
  const stored = state.materialPublications[publication.publicationId];
  const connection = state.connections[publication.connectionId];
  const source = requireWorkSource(state, publication.collectiveId, publication.sourceEventId);
  const project = requireRoadmap(state, publication.collectiveId, publication.roadmapId);
  if (
    !stored ||
    stored.state === 'withdrawn' ||
    stored.sourceId !== publication.sourceId ||
    stored.connectionId !== publication.connectionId ||
    stored.sourceEventId !== publication.sourceEventId ||
    stored.provider !== publication.provider ||
    stored.roadmapId !== publication.roadmapId ||
    !connection ||
    connection.status !== 'connected' ||
    connection.collectiveId !== publication.collectiveId ||
    connection.authorizedHumanId !== publication.humanId ||
    project.sourceLocation.channelId !== publication.channelId ||
    source.location.channelId !== publication.channelId ||
    source.recipient?.kind !== 'channel' ||
    source.actor.kind !== 'human' ||
    source.actor.humanId !== publication.humanId
  )
    throw new CollectiveServiceError('MATERIAL_SOURCE_UNAVAILABLE', 'The original material cannot be opened now', 409);
  requireHumanAuthBinding(state, publication.humanId);
  requireMembership(state, publication.collectiveId, publication.humanId);
  return structuredClone(stored);
}
