import { createHash } from 'node:crypto';
import {
  type CollectiveArtifactConstraint,
  type CollectiveArtifactRelayOperation,
  collectiveArtifactAgentRelayRequestSchema,
  collectiveArtifactRelayPollSchema,
  collectiveArtifactRelayRequestSchema,
  collectiveArtifactRelayResponseSchema,
  collectiveArtifactReviewActionInputSchema,
  collectiveMediaReviewCommandSchema,
  maxCollectiveArtifactProposalPayloadBytes,
} from '../contracts/index.js';
import { denyArtifact, requireArtifact } from './artifact-authority.js';
import type { CollectiveArtifactConstraints } from './artifact-constraints.js';
import { agentArtifactOwnerPayload, humanArtifactOwnerPayload } from './artifact-owner-payload.js';
import { bindArtifactRequestSource } from './artifact-request-sources.js';
import { recordArtifactSettlement } from './artifact-settlement.js';
import { reconcileArtifactSettlements } from './artifact-settlement-recovery.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { createSecret, type PersistentServiceState } from './persistence.js';

interface PendingOwnerOperation {
  key: string;
  fingerprint: string;
  connectionId: string;
  operation: CollectiveArtifactRelayOperation;
  promise: Promise<Record<string, unknown>>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  payloadBytes: number;
}
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 192 * 1024;
const MAX_PENDING_PAYLOAD_BYTES = 8 * 1024 * 1024;
const OWNER_TIMEOUT_MS = 10_000;

/** Only transient bounded memory carries payloads. No event log, outbox or recovery file receives content. */
export class CollectiveArtifactRelay {
  private readonly pending = new Map<string, PendingOwnerOperation>();
  private active = true;
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly constraints: CollectiveArtifactConstraints,
    private readonly now: () => number,
  ) {}

  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
    for (const [relayRef, pending] of this.pending)
      this.fail(relayRef, pending, ownerOperationError('owner_unavailable'));
  }

  request(sessionToken: string, unsafeInput: unknown): Promise<Record<string, unknown>> {
    if (!this.active) throw ownerOperationError('owner_unavailable');
    const { requestId, payload: submitted, ...target } = collectiveArtifactRelayRequestSchema.parse(unsafeInput);
    this.requireSize(submitted, MAX_PAYLOAD_BYTES);
    const reply = collectiveArtifactReviewActionInputSchema.safeParse(submitted);
    const mediaReply = collectiveMediaReviewCommandSchema.safeParse(submitted);
    const constraint =
      target.action === 'annotate' && reply.success && reply.data.action.kind === 'reply'
        ? this.constraints.issueReply(sessionToken, target, submitted)
        : target.action === 'annotate' && mediaReply.success && mediaReply.data.action.kind === 'reply'
          ? this.constraints.issueMediaReply(sessionToken, target, submitted)
          : this.constraints.issue(sessionToken, target);
    this.requireMediaAction(constraint);
    const payload = humanArtifactOwnerPayload(this.persistence.snapshot(), constraint, submitted);
    if (constraint.action === 'annotate' && payload.kind === 'annotate-published-selections')
      return this.enqueue(
        this.constraints.bindRequestTarget(constraint.decisionRef, payload.messageEventId as string),
        requestId,
        payload,
        target,
      );
    if (constraint.action === 'propose') return this.prepareHumanRequest(constraint, requestId, payload, target);
    return this.enqueue(constraint, requestId, payload, target);
  }

  private async prepareHumanRequest(
    constraint: CollectiveArtifactConstraint,
    requestId: string,
    payload: Record<string, unknown>,
    target: unknown,
  ) {
    await this.persistence.transaction((state) => bindArtifactRequestSource(state, constraint, payload));
    const bound = this.constraints.bindRequestTarget(constraint.decisionRef, payload.messageEventId as string);
    return this.enqueue(bound, requestId, payload, target);
  }

  requestAgent(credential: string, unsafeInput: unknown): Promise<Record<string, unknown>> {
    if (!this.active) throw ownerOperationError('owner_unavailable');
    const { requestId, payload: submitted, ...target } = collectiveArtifactAgentRelayRequestSchema.parse(unsafeInput);
    const limit = target.action === 'propose' ? maxCollectiveArtifactProposalPayloadBytes : MAX_PAYLOAD_BYTES;
    this.requireSize(submitted, limit);
    const constraint = this.constraints.issueAgent(credential, target);
    this.requireMediaAction(constraint);
    const payload = agentArtifactOwnerPayload(this.persistence.snapshot(), constraint, submitted);
    this.requireSize(payload, limit);
    if (constraint.action === 'propose' && payload.kind !== 'respond-modification')
      throw ownerOperationError('invalid_request');
    return this.enqueue(constraint, requestId, payload, target);
  }

  private requireMediaAction(constraint: CollectiveArtifactConstraint) {
    const artifact = requireArtifact(this.persistence.snapshot(), constraint.collectiveId, constraint.artifactId);
    if (
      ['image/png', 'video/mp4'].includes(artifact.mediaType) &&
      !['read', 'history', 'annotate'].includes(constraint.action)
    )
      throw ownerOperationError('unsupported_operation');
  }

  private enqueue(
    constraint: CollectiveArtifactConstraint,
    requestId: string,
    payload: Record<string, unknown>,
    target: unknown,
  ): Promise<Record<string, unknown>> {
    const state = this.persistence.snapshot();
    const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
    const key = JSON.stringify([constraint.humanId, constraint.agent ?? null, constraint.artifactId, requestId]);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([target, payload]))
      .digest('hex');
    for (const pending of this.pending.values()) {
      if (pending.key !== key) continue;
      if (pending.fingerprint !== fingerprint)
        throw new CollectiveServiceError(
          'COLLABORATION_OPERATION_CONFLICT',
          'Request id already names another owner operation',
          409,
        );
      return pending.promise;
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    const pendingBytes = [...this.pending.values()].reduce((total, item) => total + item.payloadBytes, 0);
    if (this.pending.size >= 100 || pendingBytes + payloadBytes > MAX_PENDING_PAYLOAD_BYTES)
      throw new CollectiveServiceError('ARTIFACT_BUSY', 'Content owner is busy; retry shortly', 429);
    const relayRef = `artifact-relay:${createSecret()}`;
    const operation = { relayRef, requestId, constraint, payload, expiresAt: this.now() + OWNER_TIMEOUT_MS };
    let resolve!: PendingOwnerOperation['resolve'];
    let reject!: PendingOwnerOperation['reject'];
    const promise = new Promise<Record<string, unknown>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      this.pending.delete(relayRef);
      reject(
        new CollectiveServiceError(
          'ARTIFACT_OWNER_UNAVAILABLE',
          'Content owner did not answer; retry the same operation',
          503,
        ),
      );
    }, OWNER_TIMEOUT_MS);
    timer.unref();
    this.pending.set(relayRef, {
      key,
      fingerprint,
      connectionId: artifact.custody.connectionId,
      operation,
      promise,
      resolve,
      reject,
      timer,
      payloadBytes,
    });
    return promise;
  }

  poll(credential: string, unsafeInput: unknown): CollectiveArtifactRelayOperation[] {
    const input = collectiveArtifactRelayPollSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const operations: CollectiveArtifactRelayOperation[] = [];
    for (const [relayRef, pending] of this.pending) {
      if (pending.connectionId !== connection.connectionId) continue;
      try {
        this.validate(credential, pending);
      } catch (error) {
        this.fail(relayRef, pending, error);
        continue;
      }
      operations.push(structuredClone(pending.operation));
      if (operations.length === 2) break;
    }
    return operations;
  }

  respond(credential: string, unsafeInput: unknown) {
    const input = collectiveArtifactRelayResponseSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const pending = this.pending.get(input.relayRef);
    if (!pending || pending.connectionId !== connection.connectionId) denyArtifact();
    try {
      this.validate(credential, pending);
      if (input.status === 'ok') this.requireSize(input.value, MAX_RESPONSE_BYTES);
    } catch (error) {
      this.fail(input.relayRef, pending, error);
      throw error;
    }
    if (
      input.status === 'ok' &&
      (pending.operation.constraint.action === 'apply' || input.value.settlementRecovery !== undefined)
    ) {
      return this.completeSettlement(credential, input.relayRef, pending, input.value);
    }
    clearTimeout(pending.timer);
    this.pending.delete(input.relayRef);
    if (input.status === 'ok') pending.resolve(structuredClone(input.value));
    else pending.reject(ownerOperationError(input.error.code));
    return { acknowledged: true };
  }

  private async completeSettlement(
    credential: string,
    relayRef: string,
    pending: PendingOwnerOperation,
    value: Record<string, unknown>,
  ) {
    try {
      let publicValue = value;
      await this.persistence.transaction((state) => {
        this.validate(credential, pending);
        if (pending.operation.constraint.action === 'apply')
          recordArtifactSettlement(state, pending.operation, value, this.now());
        else publicValue = reconcileArtifactSettlements(state, pending.operation, value, this.now());
      });
      clearTimeout(pending.timer);
      this.pending.delete(relayRef);
      pending.resolve(structuredClone(publicValue));
      return { acknowledged: true };
    } catch (error) {
      this.fail(relayRef, pending, error);
      throw error;
    }
  }

  private validate(credential: string, pending: PendingOwnerOperation) {
    const constraint = pending.operation.constraint;
    if (pending.operation.expiresAt <= this.now())
      throw new CollectiveServiceError('ARTIFACT_OWNER_UNAVAILABLE', 'Owner operation expired', 503);
    return this.constraints.validate(credential, {
      serviceInstanceId: constraint.serviceInstanceId,
      collectiveId: constraint.collectiveId,
      connectionId: pending.connectionId,
      artifactId: constraint.artifactId,
      sourceEventId: constraint.sourceEventId,
      action: constraint.action,
      ownerRevision: constraint.ownerRevision,
      decisionRef: constraint.decisionRef,
    });
  }
  private fail(relayRef: string, pending: PendingOwnerOperation, error: unknown) {
    clearTimeout(pending.timer);
    this.pending.delete(relayRef);
    pending.reject(error instanceof Error ? error : ownerOperationError('unknown'));
  }
  private requireSize(value: unknown, maxBytes: number) {
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
      throw new CollectiveServiceError(
        'INVALID_ARTIFACT_REQUEST',
        'Owner operation exceeds its content size limit',
        413,
      );
  }
}
export function ownerOperationError(
  code: 'access_denied' | 'conflict' | 'owner_unavailable' | 'invalid_request' | 'unsupported_operation' | 'unknown',
) {
  switch (code) {
    case 'unsupported_operation':
      return new CollectiveServiceError(
        'ARTIFACT_OPERATION_UNAVAILABLE',
        'This content owner does not support the requested operation',
        422,
      );
    case 'access_denied':
      return new CollectiveServiceError('ARTIFACT_ACCESS_DENIED', 'The content owner denied this operation', 403);
    case 'conflict':
      return new CollectiveServiceError(
        'ARTIFACT_REVISION_CONFLICT',
        'The content owner version changed; review the current version',
        409,
      );
    case 'invalid_request':
      return new CollectiveServiceError('INVALID_ARTIFACT_REQUEST', 'The content owner rejected this request', 400);
    default:
      return new CollectiveServiceError(
        'ARTIFACT_OWNER_UNAVAILABLE',
        'The content owner result is unavailable; retry the same operation',
        503,
      );
  }
}
