import { collectiveRetainedMediaRegistrationRequestSchema } from '../contracts/index.js';
import { denyArtifact, requireArtifactAction } from './artifact-authority.js';
import { artifactIdentity } from './artifact-registration.js';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import type { ServiceState } from './state.js';

/** Fresh endpoint/Human authority permits only exact public registration metadata, never owner content. */
export function readArtifactRegistrationContext(state: ServiceState, credential: string, unsafe: unknown) {
  const input = collectiveRetainedMediaRegistrationRequestSchema.parse(unsafe);
  const connection = requireConnection(state, credential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  const human = requireAuthorizedHuman(state, connection);
  requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const artifact = state.artifacts[artifactIdentity(input.serviceInstanceId, input.collectiveId, input.contentRef)];
  if (!artifact) return { ...input, current: null };
  requireArtifactAction(state, artifact, human.humanId, 'read');
  if (artifact.sourceEventId !== input.sourceEventId || artifact.mediaType !== input.mediaType) denyArtifact();
  return {
    ...input,
    current: {
      revision: artifact.revision,
      custodyRevision: artifact.custody.revision,
      ...(artifact.workId ? { workId: artifact.workId } : {}),
    },
  };
}
