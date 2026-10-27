import type { z } from 'zod';
import { collectiveConnectionCoordinatesSchema } from '../contracts/types/collective.js';
import {
  type CollectiveMaterialItem,
  type CollectiveMaterialPublication,
  type CollectiveMaterialSourcePort,
  type CollectiveMaterialSourceResult,
  collectiveMaterialSourceResultSchema,
  listCollectiveMaterialsRequestSchema,
  publishCollectiveMaterialRequestSchema,
  sameCollectiveMaterialWitness,
  sortCollectiveMaterialRequestSchema,
} from '../contracts/types/collective-material.js';
import { humanActor, humanEventActor, requireHumanCommand, requireRoadmap } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { createStableId, type PersistentServiceState } from './persistence.js';
import { authorizeMaterialPublication, requireMaterial } from './project-material-authority.js';
import { observePublishedMaterial } from './project-material-observation.js';
import { sortProjectMaterial } from './project-material-sort.js';
import type { ServiceState } from './state.js';

type Available = Extract<CollectiveMaterialSourceResult, { status: 'available' }>;
export class CollectiveProjectMaterialStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
    private readonly source: CollectiveMaterialSourcePort,
  ) {}

  connections(sessionToken: string, unsafe: unknown) {
    const input = listCollectiveMaterialsRequestSchema.parse(unsafe),
      state = this.persistence.snapshot();
    const human = requireHumanCommand(state, sessionToken, input);
    requireRoadmap(state, input.collectiveId, input.roadmapId);
    return {
      connections: Object.values(state.connections)
        .filter(
          (item) =>
            item.collectiveId === input.collectiveId &&
            item.status === 'connected' &&
            item.authorizedHumanId === human.humanId,
        )
        .map((item) => ({ connectionId: item.connectionId, label: item.endpointLabel })),
    };
  }

  async publish(sessionToken: string, unsafe: unknown) {
    const input = publishCollectiveMaterialRequestSchema.parse(unsafe);
    const publication = await this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      const project = requireRoadmap(state, input.collectiveId, input.roadmapId);
      const connection = state.connections[input.connectionId];
      if (
        !connection ||
        connection.status !== 'connected' ||
        connection.collectiveId !== input.collectiveId ||
        connection.authorizedHumanId !== human.humanId
      )
        throw new CollectiveServiceError('FORBIDDEN', 'Choose your own connected Cafe to publish material', 403);
      const actorScope = `human:${human.humanId}`;
      const replay = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'material',
      });
      if (replay.existing) return structuredClone(state.materialPublications[replay.existing.resourceId]!);
      const source = appendEvent(state, {
        coordinates: {
          ...input,
          clientEventId: `${input.requestId}:material`,
          location: { channelId: project.sourceLocation.channelId },
          recipient: { kind: 'channel' },
          body: '分享了一份项目材料 · 正文按原来源权限读取',
        },
        actorScope,
        actor: humanEventActor(human),
        now: this.now(),
      });
      const at = new Date(this.now()).toISOString(),
        publicationId = createStableId('materialpub_');
      const publication: CollectiveMaterialPublication = {
        ...input,
        publicationId,
        channelId: project.sourceLocation.channelId,
        sourceEventId: source.eventId,
        humanId: human.humanId,
        actor: humanActor(human),
        publishedAt: at,
        state: 'pending',
      };
      // requestId is an operation key, not part of the source-owner publication contract.
      const { requestId: _, ...record } = publication as CollectiveMaterialPublication & { requestId: string };
      state.materialPublications[publicationId] = record;
      recordCollaborationOperation(state, {
        ...replay,
        actorScope,
        resourceKind: 'material',
        resourceId: publicationId,
        revision: 1,
        recordedAt: at,
      });
      return structuredClone(record);
    });
    const source = await this.readPublication(publication, 'publish');
    if (source.status !== 'available') throw unavailable();
    return this.observe(publication, source, (state) => {
      requireHumanCommand(state, sessionToken, input);
    });
  }

  list(sessionToken: string, unsafe: unknown) {
    const input = listCollectiveMaterialsRequestSchema.parse(unsafe);
    return this.listAuthorized(input, (state) => {
      requireHumanCommand(state, sessionToken, input);
    });
  }

  listForConnection(credential: string, unsafe: unknown) {
    const input = collectiveConnectionCoordinatesSchema
      .extend({ roadmapId: listCollectiveMaterialsRequestSchema.shape.roadmapId })
      .strict()
      .parse(unsafe);
    return this.listAuthorized(input, (state) => {
      const connection = requireConnection(state, credential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      requireAuthorizedHuman(state, connection);
    });
  }

  listForParticipant(
    input: z.infer<typeof listCollectiveMaterialsRequestSchema>,
    check: (state: ServiceState) => void,
  ) {
    return this.listAuthorized(input, check);
  }

  private async listAuthorized(
    input: z.infer<typeof listCollectiveMaterialsRequestSchema>,
    check: (state: ServiceState) => void,
  ) {
    const initial = this.persistence.snapshot();
    check(initial);
    requireRoadmap(initial, input.collectiveId, input.roadmapId);
    const records = Object.values(initial.materials).filter(
      (record) => record.collectiveId === input.collectiveId && record.roadmapId === input.roadmapId,
    );
    const items: CollectiveMaterialItem[] = [],
      unavailableItems: { materialId: string; revision: number }[] = [];
    for (const record of records) {
      let available = false;
      for (const publicationId of record.publicationIds) {
        const publication = this.persistence.snapshot().materialPublications[publicationId];
        if (!publication || publication.state !== 'published') continue;
        const source = await this.readPublication(publication, 'read');
        if (source.status !== 'available' || source.sourceKey !== record.sourceKey) continue;
        const current = await this.observe(publication, source, check);
        items.push({
          ...current,
          currentWitness: source.witness,
          publication: structuredClone(publication),
          material: {
            ...source.material,
            clauses: source.material.clauses.map((clause) => {
              const { suggestedBy: _actor, suggestedWorkId: _work, ...original } = clause;
              const selection = current.selections
                ?.slice()
                .reverse()
                .find(
                  (candidate) =>
                    candidate.clauseId === clause.clauseId &&
                    sameCollectiveMaterialWitness(candidate.witness, source.witness),
                );
              return {
                ...original,
                ...(selection
                  ? {
                      suggestedBy: selection.actor,
                      ...(selection.suggestedWorkId ? { suggestedWorkId: selection.suggestedWorkId } : {}),
                    }
                  : {}),
              };
            }),
          },
          currentness: sameCollectiveMaterialWitness(current.firstWitness, source.witness)
            ? 'available_same'
            : 'revised',
        });
        available = true;
        break;
      }
      // Only previously published references are named; unshared/private sources are never enumerated.
      if (!available && !record.disposition)
        unavailableItems.push({ materialId: record.materialId, revision: record.revision });
    }
    check(this.persistence.snapshot());
    return {
      items,
      pendingCount: items.filter(
        (item) =>
          !item.disposition &&
          (item.material.clauses.length === 0 ||
            item.material.clauses.some((clause) => !item.decisions[clause.clauseId])),
      ).length,
      unavailable: unavailableItems,
    };
  }

  async sort(sessionToken: string, unsafe: unknown) {
    const input = sortCollectiveMaterialRequestSchema.parse(unsafe);
    const state = this.persistence.snapshot();
    requireHumanCommand(state, sessionToken, input);
    const record = requireMaterial(state, input.collectiveId, input.materialId);
    const project = requireRoadmap(state, input.collectiveId, record.roadmapId);
    const human = requireHumanCommand(state, sessionToken, input);
    if (project.accountableHumanId !== human.humanId)
      throw new CollectiveServiceError(
        'ROADMAP_AUTHORITY_REQUIRED',
        'Only the Project owner can sort its material',
        403,
      );
    for (const publicationId of record.publicationIds) {
      const publication = this.persistence.snapshot().materialPublications[publicationId];
      if (!publication || publication.state !== 'published') continue;
      const source = await this.readPublication(publication, 'read');
      if (source.status !== 'available' || source.sourceKey !== record.sourceKey) continue;
      await this.observe(publication, source, (state) => {
        requireHumanCommand(state, sessionToken, input);
      });
      return this.persistence.transaction((current) => {
        authorizeMaterialPublication(current, publication);
        return sortProjectMaterial(current, sessionToken, input, source, publication.publicationId, this.now());
      });
    }
    if (input.action === 'ignore' && !input.clauseId)
      return this.persistence.transaction((current) => {
        const human = requireHumanCommand(current, sessionToken, input);
        const material = current.materials[input.materialId]!;
        const project = requireRoadmap(current, input.collectiveId, material.roadmapId);
        if (project.accountableHumanId !== human.humanId)
          throw new CollectiveServiceError(
            'ROADMAP_AUTHORITY_REQUIRED',
            'Only the Project owner can sort material',
            403,
          );
        if (material.disposition)
          return {
            outcome: 'already_processed' as const,
            materialId: material.materialId,
            revision: material.revision,
            decision: structuredClone(material.disposition),
          };
        if (material.revision !== input.expectedRevision)
          throw new CollectiveServiceError(
            'MATERIAL_REVISION_CONFLICT',
            'Material changed; refresh before deciding',
            409,
          );
        const actorScope = `human:${human.humanId}`;
        const replay = collaborationOperationReplay(current, {
          ...input,
          actorScope,
          payload: input,
          resourceKind: 'material',
        });
        const at = new Date(this.now()).toISOString();
        const decision: import('../contracts/types/collective-material.js').CollectiveMaterialDecision = {
          action: 'ignore',
          actor: humanActor(human),
          at,
          requestId: input.requestId,
          witness: material.currentWitness,
        };
        material.disposition = decision;
        material.revision += 1;
        material.updatedAt = at;
        recordCollaborationOperation(current, {
          ...replay,
          actorScope,
          resourceKind: 'material',
          resourceId: material.materialId,
          revision: material.revision,
          recordedAt: at,
        });
        return {
          outcome: 'processed' as const,
          materialId: material.materialId,
          revision: material.revision,
          decision,
        };
      });
    throw unavailable();
  }

  private async readPublication(
    publication: CollectiveMaterialPublication,
    action: 'publish' | 'read',
  ): Promise<CollectiveMaterialSourceResult> {
    try {
      const reauthorize = async () => authorizeMaterialPublication(this.persistence.snapshot(), publication);
      await reauthorize();
      const result = collectiveMaterialSourceResultSchema.parse(
        await this.source.execute(
          {
            relayRef: createStableId('materialread_'),
            action,
            publication,
          },
          { reauthorize },
        ),
      );
      await reauthorize();
      if (result.status === 'available' && publication.sourceKey && result.sourceKey !== publication.sourceKey)
        return { status: 'unavailable', reason: 'not_published' };
      return result;
    } catch {
      return { status: 'unavailable', reason: 'owner_unavailable' };
    }
  }

  private observe(publication: CollectiveMaterialPublication, source: Available, check: (state: ServiceState) => void) {
    return observePublishedMaterial(this.persistence, this.now, publication, source, check);
  }
}
function unavailable() {
  return new CollectiveServiceError('MATERIAL_SOURCE_UNAVAILABLE', 'The original material cannot be opened now', 409);
}
