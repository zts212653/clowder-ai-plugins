import { createHash } from 'node:crypto';
import {
  type CollectiveArtifactPublicationOperation,
  collectiveArtifactPublicationRecoverySchema,
  collectiveArtifactPublicationUploadSchema,
  collectiveArtifactPublicationValidationSchema,
  collectiveArtifactRelayPollSchema,
  collectiveArtifactRelayResponseSchema,
} from '../contracts/index.js';
import { denyArtifact } from './artifact-authority.js';
import { projectPublication, requirePublication, requirePublicationHuman } from './artifact-publication-authority.js';
import { settleArtifactPublication } from './artifact-publication-settlement.js';
import { ownerOperationError } from './artifact-relay.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { createSecret, type PersistentServiceState, secretMatches } from './persistence.js';

interface PendingPublication {
  operation: CollectiveArtifactPublicationOperation;
  promise: Promise<Record<string, unknown>>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Dedicated short-lived RPC on the existing Connector. Only its content-free intent is recoverable here. */
export class CollectiveArtifactPublicationRelay {
  private active = true;
  private readonly pending = new Map<string, PendingPublication>();
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
    for (const [ref] of this.pending) this.fail(ref, ownerOperationError('owner_unavailable'));
  }
  send(session: string, unsafe: unknown): Promise<Record<string, unknown>> {
    const input = collectiveArtifactPublicationUploadSchema.parse(unsafe);
    const state = this.persistence.snapshot();
    const publication = requirePublicationHuman(state, session, input.publicationId);
    const bytes = Buffer.from(input.bytesBase64, 'base64');
    if (
      bytes.length > 65536 ||
      bytes.toString('base64') !== input.bytesBase64 ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== publication.blobDigest
    )
      throw new CollectiveServiceError(
        'INVALID_ARTIFACT_REQUEST',
        'Publication bytes do not match the selected Markdown',
        400,
      );
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new CollectiveServiceError('INVALID_ARTIFACT_REQUEST', 'The selected Markdown is not UTF-8', 400);
    }
    if (publication.status === 'published') return Promise.resolve(projectPublication(state, publication));
    if (!this.active) throw ownerOperationError('owner_unavailable');
    for (const pending of this.pending.values())
      if (pending.operation.publication.publicationId === publication.publicationId) return pending.promise;
    if (this.pending.size >= 100)
      throw new CollectiveServiceError('ARTIFACT_BUSY', 'Content owner is busy; retry shortly', 429);
    const relayRef = `artifact-publication-relay:${createSecret()}`;
    const operation = { relayRef, publication, bytesBase64: input.bytesBase64, expiresAt: this.now() + 10000 };
    let resolve!: PendingPublication['resolve'];
    let reject!: PendingPublication['reject'];
    const promise = new Promise<Record<string, unknown>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => this.fail(relayRef, ownerOperationError('owner_unavailable')), 10000);
    timer.unref();
    this.pending.set(relayRef, { operation, promise, resolve, reject, timer });
    return promise;
  }
  async poll(credential: string, unsafe: unknown) {
    const input = collectiveArtifactRelayPollSchema.parse(unsafe);
    this.authorizeConnection(credential, input);
    const operations: CollectiveArtifactPublicationOperation[] = [];
    for (const [ref, pending] of this.pending) {
      if (pending.operation.publication.connectionId !== input.connectionId) continue;
      try {
        this.validatePending(pending);
      } catch (error) {
        this.fail(ref, error);
        continue;
      }
      const { effectPending: _admission, ...publication } = pending.operation.publication;
      operations.push({ ...structuredClone(pending.operation), publication });
      if (operations.length === 2) break;
    }
    return operations;
  }
  async validate(credential: string, unsafe: unknown) {
    const input = collectiveArtifactPublicationValidationSchema.parse(unsafe);
    this.authorizeConnection(credential, input);
    const pending = this.pending.get(input.relayRef);
    if (
      !pending ||
      pending.operation.publication.connectionId !== input.connectionId ||
      pending.operation.publication.publicationId !== input.publicationId
    )
      denyArtifact();
    return this.persistence.transaction((state) => {
      this.validatePending(pending);
      this.authorizeConnection(credential, input);
      const record = { ...requirePublication(state, input.publicationId), effectPending: true };
      state.artifactPublications[record.publicationId] = record;
      const { effectPending: _admission, ...publication } = record;
      return publication;
    });
  }
  async respond(credential: string, unsafe: unknown) {
    const input = collectiveArtifactRelayResponseSchema.parse(unsafe);
    this.authorizeConnection(credential, input);
    const pending = this.pending.get(input.relayRef);
    if (!pending || pending.operation.publication.connectionId !== input.connectionId) denyArtifact();
    try {
      const publication = this.validatePending(pending);
      if (input.status === 'error') {
        this.fail(input.relayRef, ownerOperationError(input.error.code));
        return { acknowledged: true };
      }
      const result = await this.persistence.transaction((state) => {
        this.validatePending(pending);
        const fresh = requirePublication(state, publication.publicationId);
        return projectPublication(state, settleArtifactPublication(state, fresh, input.value, this.now()));
      });
      clearTimeout(pending.timer);
      this.pending.delete(input.relayRef);
      pending.resolve(result);
      return { acknowledged: true };
    } catch (error) {
      this.fail(input.relayRef, error);
      throw error;
    }
  }
  /** An authenticated historical endpoint may report only its exact original effect; never a new action or payload. */
  async recover(credential: string, unsafe: unknown) {
    const input = collectiveArtifactPublicationRecoverySchema.parse(unsafe);
    if (!this.active) throw ownerOperationError('owner_unavailable');
    const record = await this.persistence.transaction((state) => {
      const connection = state.connections[input.connectionId];
      if (!connection || !secretMatches(credential, connection.credentialDigest)) denyArtifact();
      assertConnectionCoordinates(state, connection, input);
      const publication = state.artifactPublications[input.publicationId];
      if (
        !publication ||
        publication.connectionId !== input.connectionId ||
        publication.endpointId !== connection.endpointId ||
        publication.humanId !== connection.authorizedHumanId ||
        publication.collectiveId !== input.collectiveId
      )
        denyArtifact();
      if (input.outcome.status === 'committed') {
        if (publication.status !== 'published' && !publication.effectPending) denyArtifact();
        return settleArtifactPublication(state, publication, { receipt: input.outcome.receipt }, this.now());
      }
      // Absence is an owner-lock fact, and may only release an active endpoint's outstanding admission.
      this.authorizeConnection(credential, input);
      if (publication.status === 'published') return publication;
      const reset = { ...publication, effectPending: false };
      state.artifactPublications[publication.publicationId] = reset;
      return reset;
    });
    for (const [ref, pending] of this.pending) {
      if (pending.operation.publication.publicationId !== record.publicationId) continue;
      if (record.status !== 'published') continue;
      try {
        const state = this.persistence.snapshot();
        const fresh = requirePublication(state, record.publicationId);
        const result = projectPublication(state, fresh);
        clearTimeout(pending.timer);
        this.pending.delete(ref);
        pending.resolve(result);
      } catch (error) {
        this.fail(ref, error);
      }
    }
    return { acknowledged: true };
  }
  private validatePending(pending: PendingPublication) {
    if (pending.operation.expiresAt <= this.now()) throw ownerOperationError('owner_unavailable');
    return requirePublication(this.persistence.snapshot(), pending.operation.publication.publicationId);
  }
  private authorizeConnection(
    credential: string,
    coordinates: { serviceInstanceId: string; collectiveId: string; connectionId: string },
  ) {
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, coordinates.connectionId);
    assertConnectionCoordinates(state, connection, coordinates);
    requireAuthorizedHuman(state, connection);
  }
  private fail(ref: string, error: unknown) {
    const pending = this.pending.get(ref);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ref);
    pending.reject(error instanceof Error ? error : ownerOperationError('unknown'));
  }
}
