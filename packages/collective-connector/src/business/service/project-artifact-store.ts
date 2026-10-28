import { createHash } from 'node:crypto';
import {
  type CollectiveProjectArtifactReference,
  changeCollectiveProjectArtifactRequestSchema,
  listCollectiveProjectArtifactsRequestSchema,
} from '../contracts/index.js';
import { requireArtifact, requireArtifactAction, requireArtifactCustodian } from './artifact-authority.js';
import { humanActor, humanEventActor, requireHumanCommand } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import type { PersistentServiceState } from './persistence.js';
import {
  mapProjectArtifactReads,
  type ProjectArtifactOwnerRead,
  verifyProjectArtifactOwner,
} from './project-artifact-owner-read.js';
import {
  projectArtifactReference,
  requireReadableArtifactProject,
  sameProjectArtifactVersion,
} from './project-artifact-projection.js';

export class CollectiveProjectArtifactStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
    private readonly readOwner: ProjectArtifactOwnerRead,
  ) {}

  async list(session: string, unsafe: unknown) {
    const input = listCollectiveProjectArtifactsRequestSchema.parse(unsafe),
      state = this.persistence.snapshot();
    const human = requireHumanCommand(state, session, input);
    requireReadableArtifactProject(state, input.collectiveId, input.roadmapId);
    const all = Object.values(state.projectArtifactReferences)
      .filter(
        (reference) =>
          reference.collectiveId === input.collectiveId &&
          reference.roadmapId === input.roadmapId &&
          reference.status === 'active',
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const snapshot = `sha256:${createHash('sha256')
      .update(JSON.stringify(all.map((ref) => [ref.referenceId, ref.revision])))
      .digest('hex')}`;
    if (input.expectedSnapshot && input.expectedSnapshot !== snapshot)
      throw new CollectiveServiceError('ROADMAP_REVISION_CONFLICT', 'Project reference page changed; reload it', 409);
    const page = all.slice(input.offset, input.offset + input.limit);
    const proofs = await mapProjectArtifactReads(page, async (reference) => {
      const projection = projectArtifactReference(state, reference, human.humanId);
      if (projection.availability !== 'available')
        return { failure: projection.availability, latestRevision: 0, latestReadable: false };
      const failure = await verifyProjectArtifactOwner(this.readOwner, state, session, reference);
      const latest = state.artifacts[reference.artifactId]!.versions.at(-1)!;
      const latestReadable =
        !failure &&
        (latest.ownerRevision === reference.versionRef.ownerRevision ||
          !(await verifyProjectArtifactOwner(this.readOwner, state, session, { ...reference, versionRef: latest })));
      return { failure, latestRevision: latest.ownerRevision, latestReadable };
    });
    const fresh = this.persistence.snapshot(),
      currentHuman = requireHumanCommand(fresh, session, input);
    requireReadableArtifactProject(fresh, input.collectiveId, input.roadmapId);
    const items = page.flatMap((reference, index) => {
      const current = fresh.projectArtifactReferences[reference.referenceId],
        proof = proofs[index]!;
      if (!current || current.status !== 'active') return [];
      const projection = projectArtifactReference(
        fresh,
        current,
        currentHuman.humanId,
        current.revision !== reference.revision ? 'version_unavailable' : proof.failure,
      );
      if (
        projection.availability === 'available' &&
        (!proof.latestReadable || projection.latestVersionRef?.ownerRevision !== proof.latestRevision)
      )
        return [{ ...projection, latestVersionRef: undefined, hasUpdate: false }];
      return [projection];
    });
    return {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      roadmapId: input.roadmapId,
      snapshot,
      offset: input.offset,
      total: all.length,
      ...(input.offset + page.length < all.length ? { nextOffset: input.offset + page.length } : {}),
      items,
      removedReferences: Object.values(fresh.projectArtifactReferences)
        .filter(
          (reference) =>
            reference.collectiveId === input.collectiveId &&
            reference.roadmapId === input.roadmapId &&
            reference.status === 'removed',
        )
        .map((reference) => ({ artifactId: reference.artifactId, revision: reference.revision })),
    };
  }

  async change(session: string, unsafe: unknown) {
    const input = changeCollectiveProjectArtifactRequestSchema.parse(unsafe);
    if (input.action !== 'remove') {
      const initial = this.persistence.snapshot(),
        human = requireHumanCommand(initial, session, input);
      const project = requireReadableArtifactProject(initial, input.collectiveId, input.roadmapId);
      if (project.accountableHumanId !== human.humanId)
        throw new CollectiveServiceError(
          'ROADMAP_AUTHORITY_REQUIRED',
          'Only the project owner can change its artifact references',
          403,
        );
      const artifact = requireArtifact(initial, input.collectiveId, input.artifactId);
      requireArtifactAction(initial, artifact, human.humanId, 'read');
      if (!artifact.versions.some((version) => sameProjectArtifactVersion(version, input.versionRef)))
        throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'Choose an exact original version', 409);
      const failure = await verifyProjectArtifactOwner(this.readOwner, initial, session, input);
      if (failure) {
        const fresh = this.persistence.snapshot(),
          currentHuman = requireHumanCommand(fresh, session, input);
        const currentProject = requireReadableArtifactProject(fresh, input.collectiveId, input.roadmapId);
        if (currentProject.accountableHumanId !== currentHuman.humanId)
          throw new CollectiveServiceError(
            'ROADMAP_AUTHORITY_REQUIRED',
            'Only the project owner can change its artifact references',
            403,
          );
        const replay = collaborationOperationReplay(fresh, {
          ...input,
          actorScope: `human:${currentHuman.humanId}`,
          payload: input,
          resourceKind: 'project_artifact',
        });
        const current = replay.existing && fresh.projectArtifactReferences[replay.existing.resourceId];
        if (current)
          return {
            outcome: 'replayed' as const,
            item: projectArtifactReference(fresh, current, currentHuman.humanId, failure),
          };
        throw new CollectiveServiceError(
          failure === 'access_denied'
            ? 'ARTIFACT_ACCESS_DENIED'
            : failure === 'version_unavailable'
              ? 'ARTIFACT_REVISION_CONFLICT'
              : 'ARTIFACT_OWNER_UNAVAILABLE',
          'The original owner cannot authorize this exact version now',
          failure === 'access_denied' ? 403 : failure === 'version_unavailable' ? 409 : 503,
        );
      }
    }
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, session, input);
      const project = requireReadableArtifactProject(state, input.collectiveId, input.roadmapId);
      if (project.accountableHumanId !== human.humanId)
        throw new CollectiveServiceError(
          'ROADMAP_AUTHORITY_REQUIRED',
          'Only the project owner can change its artifact references',
          403,
        );
      const actorScope = `human:${human.humanId}`;
      const operation = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'project_artifact',
      });
      const referenceId = `projectartifact_${createHash('sha256')
        .update(JSON.stringify([input.serviceInstanceId, input.collectiveId, input.roadmapId, input.artifactId]))
        .digest('hex')}`;
      const previous = state.projectArtifactReferences[referenceId];
      if (operation.existing)
        return {
          outcome: 'replayed' as const,
          item: previous ? projectArtifactReference(state, previous, human.humanId) : null,
        };
      if (
        (previous?.revision ?? 0) !== input.expectedRevision ||
        (input.action === 'attach' ? previous?.status === 'active' : previous?.status !== 'active')
      )
        return {
          outcome: 'conflict' as const,
          item: previous ? projectArtifactReference(state, previous, human.humanId) : null,
        };
      // Removal is allowed after revocation or an owner outage: it only releases this project's relation.
      if (input.action !== 'remove') {
        const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
        requireArtifactAction(state, artifact, human.humanId, 'read');
        requireArtifactCustodian(state, artifact);
        if (!artifact.versions.some((version) => sameProjectArtifactVersion(version, input.versionRef)))
          throw new CollectiveServiceError(
            'ARTIFACT_REVISION_CONFLICT',
            'Choose an exact version supplied by the original owner history',
            409,
          );
        if (input.action === 'keep' && input.versionRef.ownerRevision <= (previous?.versionRef.ownerRevision ?? 0))
          throw new CollectiveServiceError(
            'ARTIFACT_REVISION_CONFLICT',
            'Keep applies only to the newer version you observed',
            409,
          );
      }
      if (
        (previous?.history.length ?? 0) >= 10000 ||
        (!previous &&
          Object.values(state.projectArtifactReferences).filter((ref) => ref.roadmapId === project.roadmapId).length >=
            1000)
      )
        throw new CollectiveServiceError('FORBIDDEN', 'Project artifact reference limit reached', 413);
      const now = this.now(),
        at = new Date(now).toISOString();
      const versionRef =
        input.action === 'attach' || input.action === 'switch' ? input.versionRef : previous!.versionRef;
      const source = appendEvent(state, {
        coordinates: {
          serviceInstanceId: input.serviceInstanceId,
          collectiveId: input.collectiveId,
          clientEventId: `project-artifact:${input.requestId}`,
          location: project.sourceLocation,
          recipient: { kind: 'channel' },
          body: `项目「${project.title}」${{ attach: '引用', switch: '换用', keep: '保持', remove: '移出' }[input.action]}作品 v${versionRef.ownerRevision}${input.action === 'keep' ? `，本次不换用 v${input.versionRef.ownerRevision}` : ''}`,
        },
        actorScope,
        actor: humanEventActor(human),
        now,
      });
      const reference: CollectiveProjectArtifactReference = {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        referenceId,
        roadmapId: project.roadmapId,
        artifactId: input.artifactId,
        versionRef: structuredClone(versionRef),
        ...(input.action === 'keep'
          ? { keptVersionRef: input.versionRef }
          : input.action === 'remove' && previous?.keptVersionRef
            ? { keptVersionRef: previous.keptVersionRef }
            : {}),
        status: input.action === 'remove' ? 'removed' : 'active',
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
        history: [
          ...(previous?.history ?? []),
          {
            revision: (previous?.revision ?? 0) + 1,
            action: input.action,
            actor: humanActor(human),
            at,
            sourceEventId: source.eventId,
            versionRef: structuredClone(versionRef),
            ...(previous ? { previousVersionRef: structuredClone(previous.versionRef) } : {}),
            ...(input.action === 'keep' ? { observedVersionRef: input.versionRef } : {}),
          },
        ],
      };
      state.projectArtifactReferences[referenceId] = structuredClone(reference);
      recordCollaborationOperation(state, {
        ...operation,
        actorScope,
        resourceKind: 'project_artifact',
        resourceId: referenceId,
        revision: reference.revision,
        recordedAt: at,
      });
      return { outcome: 'changed' as const, item: projectArtifactReference(state, reference, human.humanId) };
    });
  }
}
