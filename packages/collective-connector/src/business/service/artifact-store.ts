import { listCollectiveArtifactsSchema, registerCollectiveArtifactSchema } from '../contracts/index.js';
import { CollectiveArtifactAccess } from './artifact-access.js';
import {
  denyArtifact,
  projectArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactHuman,
} from './artifact-authority.js';
import { CollectiveArtifactConstraints } from './artifact-constraints.js';
import { CollectiveArtifactCustody } from './artifact-custody.js';
import { CollectiveArtifactCustodyPages } from './artifact-custody-pages.js';
import { readArtifactHistory } from './artifact-history.js';
import { CollectiveArtifactMediaRelay } from './artifact-media-relay.js';
import { CollectiveArtifactPublicationRelay } from './artifact-publication-relay.js';
import { artifactIdentity, registerArtifactVersion } from './artifact-registration.js';
import { readArtifactRegistrationContext } from './artifact-registration-context.js';
import { CollectiveArtifactRelay } from './artifact-relay.js';
import { publishArtifactRequest } from './artifact-request-publish.js';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  assertConnectionCoordinates,
  assertServiceCoordinates,
  requireAuthorizedHuman,
  requireConnection,
} from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import type { PersistentServiceState } from './persistence.js';

export class CollectiveArtifactStore {
  readonly constraints: CollectiveArtifactConstraints;
  readonly access: CollectiveArtifactAccess;
  readonly custody: CollectiveArtifactCustody;
  readonly custodyPages: CollectiveArtifactCustodyPages;
  readonly relay: CollectiveArtifactRelay;
  readonly publications: CollectiveArtifactPublicationRelay;
  readonly media: CollectiveArtifactMediaRelay;
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {
    this.constraints = new CollectiveArtifactConstraints(persistence, now);
    this.access = new CollectiveArtifactAccess(persistence, now);
    this.custody = new CollectiveArtifactCustody(persistence, now);
    this.custodyPages = new CollectiveArtifactCustodyPages(persistence, this.custody.transfers, now);
    this.relay = new CollectiveArtifactRelay(persistence, this.constraints, now);
    this.publications = new CollectiveArtifactPublicationRelay(persistence, now);
    this.media = new CollectiveArtifactMediaRelay(persistence, this.constraints, now);
  }
  publishRequest(session: string, input: unknown) {
    return publishArtifactRequest(this.persistence, this.constraints, this.now, session, input);
  }
  registrationContext(credential: string, input: unknown) {
    return readArtifactRegistrationContext(this.persistence.snapshot(), credential, input);
  }
  async register(credential: string, unsafeInput: unknown) {
    const input = registerCollectiveArtifactSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, credential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const human = requireAuthorizedHuman(state, connection);
      const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
      if (input.workId) {
        const work = state.works[input.workId];
        if (!work || work.collectiveId !== input.collectiveId || work.sourceEventId !== source.eventId) denyArtifact();
      }
      const artifactId = artifactIdentity(input.serviceInstanceId, input.collectiveId, input.contentRef);
      const previous = state.artifacts[artifactId];
      if (previous && previous.custody.connectionId !== connection.connectionId) denyArtifact();
      const operation = collaborationOperationReplay(state, {
        ...input,
        actorScope: `connection:${connection.connectionId}`,
        payload: input,
        resourceKind: 'artifact',
      });
      if (operation.existing)
        return projectArtifact(
          state,
          requireArtifact(state, input.collectiveId, operation.existing.resourceId),
          human.humanId,
        );
      const at = new Date(this.now()).toISOString();
      const artifact = registerArtifactVersion(
        input,
        { humanId: human.humanId, endpointId: connection.endpointId, sourceLocation: source.location, at },
        previous,
      );
      state.artifacts[artifactId] = structuredClone(artifact);
      recordCollaborationOperation(state, {
        ...operation,
        actorScope: `connection:${connection.connectionId}`,
        resourceKind: 'artifact',
        resourceId: artifactId,
        revision: artifact.revision,
        recordedAt: at,
      });
      return projectArtifact(state, artifact, human.humanId);
    });
  }
  history(session: string, input: unknown) {
    return readArtifactHistory(this.persistence.snapshot(), session, input);
  }
  list(sessionToken: string, unsafeInput: unknown) {
    const input = listCollectiveArtifactsSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
    const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
    return Object.values(state.artifacts).flatMap((artifact) => {
      if (
        artifact.collectiveId !== input.collectiveId ||
        (input.channelId && artifact.sourceLocation.channelId !== input.channelId)
      )
        return [];
      try {
        requireArtifactAction(state, artifact, human.humanId, 'read');
        return [projectArtifact(state, artifact, human.humanId)];
      } catch (error) {
        if (error instanceof CollectiveServiceError) return [];
        throw error;
      }
    });
  }
}
