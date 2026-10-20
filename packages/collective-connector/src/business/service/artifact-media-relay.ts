import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type CollectiveArtifactMediaOperation,
  type CollectiveMediaDescriptor,
  collectiveMediaBufferBytes,
  collectiveMediaCoordinatesSchema,
  collectiveMediaDescriptorSchema,
  collectiveMediaReadRequestSchema,
  collectiveMediaRelaySlots,
  collectiveMediaResponseCoordinatesSchema,
  collectiveMediaResponseLength,
} from '../contracts/index.js';
import { denyArtifact, requireArtifact } from './artifact-authority.js';
import type { CollectiveArtifactConstraints } from './artifact-constraints.js';
import { assertMediaDescriptor, assertMediaOwner, assertMediaReader } from './artifact-media-authority.js';
import { exactMediaLength } from './artifact-media-stream.js';
import { ownerOperationError } from './artifact-relay.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { createSecret, type PersistentServiceState } from './persistence.js';
import type { ConnectionRecord } from './state.js';

export interface OpenMedia {
  descriptor: CollectiveMediaDescriptor;
  body: PassThrough;
}
interface PendingMedia {
  operation: CollectiveArtifactMediaOperation;
  reader: Pick<ConnectionRecord, 'connectionId' | 'endpointId' | 'authorizedHumanId' | 'credentialDigest'>;
  resolve(value: OpenMedia): void;
  reject(error: unknown): void;
  cleanup(): void;
  timer: ReturnType<typeof setTimeout>;
  body?: PassThrough;
}
/** Ephemeral bounded streams only. Nothing in this relay enters Service persistence. */
export class CollectiveArtifactMediaRelay {
  private readonly pending = new Map<string, PendingMedia>();
  private active = false;
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
    for (const [ref] of this.pending) this.fail(ref, ownerOperationError('owner_unavailable'));
  }
  request(credential: string, unsafe: unknown, signal: AbortSignal): Promise<OpenMedia> {
    if (!this.active) throw ownerOperationError('owner_unavailable');
    const input = collectiveMediaReadRequestSchema.parse(unsafe);
    const constraint = this.constraints.issueMediaRead(credential, input);
    const state = this.persistence.snapshot(),
      connection = requireConnection(state, credential, input.connectionId);
    if (this.pending.size >= collectiveMediaRelaySlots)
      throw new CollectiveServiceError('ARTIFACT_BUSY', 'Media streams are busy; retry this range', 429);
    signal.throwIfAborted();
    const relayRef = `collective-media:${createSecret()}`;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(relayRef, ownerOperationError('owner_unavailable'));
      const timer = setTimeout(abort, 10000);
      timer.unref();
      this.pending.set(relayRef, {
        operation: {
          relayRef,
          constraint,
          ...(input.range === undefined ? {} : { range: input.range }),
          expiresAt: this.now() + 10000,
        },
        reader: {
          connectionId: connection.connectionId,
          endpointId: connection.endpointId,
          authorizedHumanId: connection.authorizedHumanId,
          credentialDigest: connection.credentialDigest,
        },
        resolve,
        reject,
        timer,
        cleanup: () => signal.removeEventListener('abort', abort),
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  poll(credential: string, unsafe: unknown) {
    const input = collectiveMediaCoordinatesSchema.parse(unsafe),
      state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const operations: CollectiveArtifactMediaOperation[] = [];
    for (const [ref, entry] of this.pending) {
      if (entry.body || entry.operation.constraint.collectiveId !== input.collectiveId) continue;
      const artifact = requireArtifact(state, input.collectiveId, entry.operation.constraint.artifactId);
      if (artifact.custody.connectionId !== input.connectionId) continue;
      try {
        this.authorize(credential, input.connectionId, entry);
        operations.push(structuredClone(entry.operation));
      } catch (error) {
        this.fail(ref, error);
      }
      if (operations.length === 2) break;
    }
    return operations;
  }
  async respond(
    credential: string,
    unsafe: unknown,
    metadata: unknown,
    errorCode: Parameters<typeof ownerOperationError>[0] | undefined,
    request: IncomingMessage,
  ) {
    const input = collectiveMediaResponseCoordinatesSchema.parse(unsafe),
      state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const entry = this.pending.get(input.relayRef);
    if (!entry) throw ownerOperationError('owner_unavailable');
    const c = entry.operation.constraint;
    if (
      c.serviceInstanceId !== input.serviceInstanceId ||
      c.collectiveId !== input.collectiveId ||
      requireArtifact(state, c.collectiveId, c.artifactId).custody.connectionId !== input.connectionId
    )
      denyArtifact();
    // The second transport must not tear down a first response that has already passed disclosure checks.
    if (entry.body) throw ownerOperationError('conflict');
    try {
      this.authorize(credential, input.connectionId, entry);
      if (errorCode) {
        if (request.headers['content-length'] !== '0') throw ownerOperationError('invalid_request');
        request.resume();
        this.fail(input.relayRef, ownerOperationError(errorCode));
        return;
      }
      const descriptor = collectiveMediaDescriptorSchema.parse(metadata);
      assertMediaDescriptor(this.persistence.snapshot(), entry.operation, descriptor);
      this.authorize(credential, input.connectionId, entry);
      const body = new PassThrough({ highWaterMark: collectiveMediaBufferBytes });
      body.on('error', () => {});
      entry.body = body;
      clearTimeout(entry.timer);
      body.once('end', () => this.release(input.relayRef));
      body.once('close', () => this.release(input.relayRef));
      entry.resolve({ descriptor, body });
      request.setTimeout(60000, () => request.destroy(new Error('Media transport idle timeout')));
      await pipeline(request, exactMediaLength(collectiveMediaResponseLength(descriptor)), body);
    } catch (error) {
      this.fail(input.relayRef, error);
      throw error;
    } finally {
      request.setTimeout(0);
    }
  }
  private authorize(credential: string, connectionId: string, entry: PendingMedia) {
    if (!this.active || entry.operation.expiresAt <= this.now()) throw ownerOperationError('owner_unavailable');
    assertMediaReader(this.persistence.snapshot(), entry.reader);
    assertMediaOwner(this.constraints, credential, connectionId, entry.operation);
  }
  private release(ref: string) {
    const entry = this.pending.get(ref);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.cleanup();
    this.pending.delete(ref);
  }
  private fail(ref: string, error: unknown) {
    const entry = this.pending.get(ref);
    if (!entry) return;
    this.release(ref);
    entry.body?.destroy(error instanceof Error ? error : new Error('Media relay failed'));
    entry.reject(error);
  }
}
