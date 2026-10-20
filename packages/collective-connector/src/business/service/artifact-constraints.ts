import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactConstraint,
  type CollectiveArtifactRecord,
  collectiveArtifactAgentConstraintRequestSchema,
  collectiveArtifactConstraintRequestSchema,
  collectiveArtifactReviewActionInputSchema,
  collectiveMediaReadRequestSchema,
  collectiveMediaReviewCommandSchema,
  validateCollectiveArtifactConstraintSchema,
} from '../contracts/index.js';
import { resolveArtifactRequestAgent } from './artifact-agent-authority.js';
import {
  artifactAccess,
  denyArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactCustodian,
  requireArtifactHuman,
} from './artifact-authority.js';
import { artifactEffectsFrozen, assertArtifactEffectAvailable } from './artifact-custody-authority.js';
import { requirePublicArtifactMessage } from './artifact-owner-payload.js';
import {
  assertConnectionCoordinates,
  assertServiceCoordinates,
  requireAuthorizedHuman,
  requireConnection,
} from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { createSecret, type PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

const needsCurrentVersion = (action: string) => ['annotate', 'propose', 'apply', 'cancel', 'reject'].includes(action);
function requiresCurrentVersion(
  subject: Pick<CollectiveArtifactConstraint, 'action' | 'agent' | 'reviewReply' | 'mediaReviewReply'>,
) {
  return needsCurrentVersion(subject.action) && !subject.agent && !subject.reviewReply && !subject.mediaReviewReply;
}
/** Short-lived transport capabilities; membership, per-Human access and custody are always read fresh. */
export class CollectiveArtifactConstraints {
  private readonly decisions = new Map<string, CollectiveArtifactConstraint>();
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}
  issue(sessionToken: string, unsafeInput: unknown): CollectiveArtifactConstraint {
    const input = collectiveArtifactConstraintRequestSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
    const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
    return this.createDecision(state, input, human.humanId);
  }
  /** A paired Host can read for its currently bound Human; this port cannot issue a write capability. */
  issueMediaRead(credential: string, unsafe: unknown): CollectiveArtifactConstraint {
    const input = collectiveMediaReadRequestSchema.parse(unsafe),
      state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    const human = requireAuthorizedHuman(state, connection);
    const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
    if (!['image/png', 'video/mp4'].includes(artifact.mediaType))
      throw new CollectiveServiceError(
        'ARTIFACT_OPERATION_UNAVAILABLE',
        'This owner has no retained media read port',
        422,
      );
    return this.createDecision(state, { ...input, action: 'read' }, human.humanId);
  }
  issueReply(sessionToken: string, unsafeInput: unknown, payload: unknown): CollectiveArtifactConstraint {
    const input = collectiveArtifactConstraintRequestSchema.parse(unsafeInput);
    const command = collectiveArtifactReviewActionInputSchema.parse(payload);
    const state = this.persistence.snapshot();
    assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
    const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
    const action = command.action;
    if (input.action !== 'annotate' || action.kind !== 'reply') denyArtifact();
    const { message } = requirePublicArtifactMessage(
      state,
      { ...input, humanId: human.humanId },
      action.messageEventId,
    );
    if (!message.replyToEventId) denyArtifact();
    return this.createDecision(state, input, human.humanId, undefined, {
      annotationId: action.annotationId,
      messageEventId: action.messageEventId,
    });
  }

  issueAgent(credential: string, raw: unknown): CollectiveArtifactConstraint {
    const input = collectiveArtifactAgentConstraintRequestSchema.parse(raw);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    if (!['read', 'preview', 'propose'].includes(input.action)) denyArtifact();
    const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
    const resolved = resolveArtifactRequestAgent(state, artifact, input.requestEventId);
    if (
      resolved.agent.connectionId !== connection.connectionId ||
      resolved.agent.catId !== input.catId ||
      resolved.agent.participationRevision !== input.participationRevision
    )
      denyArtifact();
    const bound = artifact.requestSources[input.requestEventId];
    if (!bound || (input.ownerRevision !== undefined && input.ownerRevision !== bound.ownerRevision)) denyArtifact();
    return this.createDecision(
      state,
      { ...input, ownerRevision: bound.ownerRevision },
      resolved.humanId,
      resolved.agent,
    );
  }

  issueMediaReply(sessionToken: string, unsafeInput: unknown, payload: unknown): CollectiveArtifactConstraint {
    const input = collectiveArtifactConstraintRequestSchema.parse(unsafeInput);
    const command = collectiveMediaReviewCommandSchema.parse(payload);
    const state = this.persistence.snapshot();
    assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
    const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
    const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
    if (
      input.action !== 'annotate' ||
      command.action.kind !== 'reply' ||
      !['image/png', 'video/mp4'].includes(artifact.mediaType)
    )
      denyArtifact();
    return this.createDecision(state, input, human.humanId, undefined, undefined, {
      annotationId: command.action.annotationId,
    });
  }

  bindRequestTarget(decisionRef: string, requestEventId: string): CollectiveArtifactConstraint {
    const decision = this.decisions.get(decisionRef);
    if (!decision || decision.agent || !['propose', 'annotate'].includes(decision.action)) denyArtifact();
    const state = this.persistence.snapshot();
    const artifact = requireArtifact(state, decision.collectiveId, decision.artifactId);
    const resolved = resolveArtifactRequestAgent(state, artifact, requestEventId, decision.humanId);
    const bound = { ...decision, requestTarget: resolved.agent };
    this.decisions.set(decisionRef, bound);
    return structuredClone(bound);
  }

  private createDecision(
    state: ServiceState,
    input: {
      collectiveId: string;
      artifactId: string;
      sourceEventId: string;
      action: CollectiveArtifactConstraint['action'];
      ownerRevision?: number;
    },
    humanId: string,
    agent?: CollectiveArtifactConstraint['agent'],
    reviewReply?: CollectiveArtifactConstraint['reviewReply'],
    mediaReviewReply?: CollectiveArtifactConstraint['mediaReviewReply'],
  ): CollectiveArtifactConstraint {
    const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
    const membership = requireArtifactAction(state, artifact, humanId, input.action);
    const replayOnly = Boolean(agent) && input.action === 'propose' && artifactEffectsFrozen(artifact);
    assertArtifactEffectAvailable(artifact, !replayOnly && (Boolean(agent) || needsCurrentVersion(input.action)));
    if (input.sourceEventId !== artifact.sourceEventId) denyArtifact();
    requireArtifactCustodian(state, artifact);
    const version =
      input.ownerRevision === undefined
        ? artifact.versions.at(-1)
        : artifact.versions.find((item) => item.ownerRevision === input.ownerRevision);
    if (!version) denyArtifact();
    if (
      requiresCurrentVersion({ action: input.action, agent, reviewReply, mediaReviewReply }) &&
      version !== artifact.versions.at(-1)
    )
      versionConflict();
    this.requireDecisionCapacity();
    const constraint: CollectiveArtifactConstraint = {
      serviceInstanceId: state.serviceInstanceId,
      collectiveId: artifact.collectiveId,
      artifactId: artifact.artifactId,
      contentRef: artifact.contentRef,
      humanId,
      action: input.action,
      sourceEventId: artifact.sourceEventId,
      custodyRevision: artifact.custody.revision,
      ownerRevision: version.ownerRevision,
      catalogueOwnerRevision: artifact.versions.at(-1)?.ownerRevision,
      blobDigest: version.blobDigest,
      membershipRevision: membership.revision,
      revocationEpoch: artifactAccess(artifact, humanId).revision,
      decisionRef: `collective-domain:${createSecret()}`,
      expiresAt: this.now() + 30_000,
      ...(agent ? { agent } : {}),
      ...(reviewReply ? { reviewReply } : {}),
      ...(mediaReviewReply ? { mediaReviewReply } : {}),
      ...(replayOnly ? { effectMode: 'replay_only' as const } : {}),
    };
    this.decisions.set(constraint.decisionRef, constraint);
    return structuredClone(constraint);
  }
  validate(credential: string, unsafeInput: unknown): CollectiveArtifactConstraint {
    const input = validateCollectiveArtifactConstraintSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const decision = this.decisions.get(input.decisionRef);
    if (
      !decision ||
      decision.expiresAt <= this.now() ||
      decision.artifactId !== input.artifactId ||
      decision.action !== input.action ||
      decision.sourceEventId !== input.sourceEventId ||
      decision.collectiveId !== input.collectiveId ||
      (input.ownerRevision !== undefined && input.ownerRevision !== decision.ownerRevision)
    )
      denyArtifact();
    const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
    requireArtifactCustodian(state, artifact);
    const membership = requireArtifactAction(state, artifact, decision.humanId, decision.action);
    assertConstraintEffectAvailable(artifact, decision);
    if (
      artifact.custody.connectionId !== connection.connectionId ||
      artifact.custody.revision !== decision.custodyRevision ||
      membership.revision !== decision.membershipRevision ||
      artifactAccess(artifact, decision.humanId).revision !== decision.revocationEpoch
    )
      denyArtifact();
    if (requiresCurrentVersion(decision) && artifact.versions.at(-1)?.ownerRevision !== decision.ownerRevision)
      versionConflict();
    assertReviewReplySubject(state, artifact, decision);
    for (const expected of [decision.agent, decision.requestTarget]) {
      if (!expected) continue;
      const fresh = resolveArtifactRequestAgent(state, artifact, expected.requestEventId, decision.humanId);
      if (!isDeepStrictEqual(fresh.agent, expected)) denyArtifact();
    }
    return structuredClone(decision);
  }
  private requireDecisionCapacity() {
    for (const [key, decision] of this.decisions) if (decision.expiresAt <= this.now()) this.decisions.delete(key);
    if (this.decisions.size >= 10_000)
      throw new CollectiveServiceError('ARTIFACT_BUSY', 'Shared work is busy; try again', 429);
  }
}

function assertReviewReplySubject(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  decision: CollectiveArtifactConstraint,
) {
  if (decision.reviewReply) {
    if (decision.action !== 'annotate' || decision.agent) denyArtifact();
    const { message } = requirePublicArtifactMessage(state, decision, decision.reviewReply.messageEventId);
    if (!message.replyToEventId) denyArtifact();
  }
  if (
    decision.mediaReviewReply &&
    (decision.action !== 'annotate' ||
      decision.agent ||
      decision.reviewReply ||
      !['image/png', 'video/mp4'].includes(artifact.mediaType))
  )
    denyArtifact();
}

function assertConstraintEffectAvailable(artifact: CollectiveArtifactRecord, decision: CollectiveArtifactConstraint) {
  if (decision.effectMode && (!decision.agent || decision.action !== 'propose' || !artifactEffectsFrozen(artifact)))
    denyArtifact();
  assertArtifactEffectAvailable(
    artifact,
    !decision.effectMode && (Boolean(decision.agent) || needsCurrentVersion(decision.action)),
  );
}

function versionConflict(): never {
  throw new CollectiveServiceError(
    'ARTIFACT_REVISION_CONFLICT',
    'The shared work has a newer version; review it before continuing',
    409,
  );
}
