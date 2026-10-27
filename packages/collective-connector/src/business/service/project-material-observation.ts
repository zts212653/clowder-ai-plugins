import { createHash } from 'node:crypto';
import type {
  CollectiveMaterialPublication,
  CollectiveMaterialSourceResult,
} from '../contracts/types/collective-material.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';
import { authorizeMaterialPublication } from './project-material-authority.js';

/** Persist provenance and revision witnesses only; source content remains with its owner. */
export function observePublishedMaterial(
  persistence: PersistentServiceState,
  now: () => number,
  publication: CollectiveMaterialPublication,
  source: Extract<CollectiveMaterialSourceResult, { status: 'available' }>,
  check: (state: ServiceState) => void,
) {
  const snapshot = persistence.snapshot();
  check(snapshot);
  authorizeMaterialPublication(snapshot, publication);
  const materialId = `material_${createHash('sha256')
    .update(JSON.stringify([publication.collectiveId, publication.roadmapId, source.sourceKey]))
    .digest('hex')}`;
  const pub = snapshot.materialPublications[publication.publicationId],
    previous = snapshot.materials[materialId];
  if (
    pub?.state === 'published' &&
    pub.sourceKey === source.sourceKey &&
    pub.sourceRef === source.sourceRef &&
    previous?.publicationIds.includes(publication.publicationId) &&
    previous.currentWitness.digest === source.witness.digest &&
    previous.currentWitness.providerRevision === source.witness.providerRevision &&
    previous.currentWitness.generationScope === source.witness.generationScope
  )
    return Promise.resolve(structuredClone(previous));
  return persistence.transaction((state) => {
    check(state);
    authorizeMaterialPublication(state, publication);
    const pub = state.materialPublications[publication.publicationId]!;
    pub.state = 'published';
    pub.sourceKey = source.sourceKey;
    pub.sourceRef = source.sourceRef;
    pub.witness = source.witness;
    const materialId = `material_${createHash('sha256')
      .update(JSON.stringify([publication.collectiveId, publication.roadmapId, source.sourceKey]))
      .digest('hex')}`;
    const at = new Date(now()).toISOString();
    const previous = state.materials[materialId];
    if (!previous)
      state.materials[materialId] = {
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: publication.collectiveId,
        materialId,
        roadmapId: publication.roadmapId,
        sourceKey: source.sourceKey,
        publicationIds: [publication.publicationId],
        revision: 1,
        firstWitness: source.witness,
        currentWitness: source.witness,
        witnesses: [source.witness],
        decisions: {},
        createdAt: at,
        updatedAt: at,
      };
    else {
      let changed = false;
      if (!previous.publicationIds.includes(publication.publicationId)) {
        previous.publicationIds.push(publication.publicationId);
        changed = true;
      }
      if (
        previous.currentWitness.digest !== source.witness.digest ||
        previous.currentWitness.providerRevision !== source.witness.providerRevision ||
        previous.currentWitness.generationScope !== source.witness.generationScope
      ) {
        previous.currentWitness = source.witness;
        previous.witnesses.push(source.witness);
        changed = true;
      }
      if (changed) {
        previous.revision += 1;
        previous.updatedAt = at;
      }
    }
    return structuredClone(state.materials[materialId]!);
  });
}
