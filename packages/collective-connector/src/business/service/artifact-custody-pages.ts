import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  COLLECTIVE_CUSTODY_PAGE_BYTES,
  type CollectiveArtifactCustodyTransfer,
  type CollectiveCustodyPage,
  type CollectiveCustodyPageOperation,
  collectiveCustodyEndpointSchema,
  collectiveCustodyPageRequestSchema,
  collectiveCustodyPageResponseSchema,
} from '../contracts/index.js';
import { artifactAccess, denyArtifact } from './artifact-authority.js';
import { requireCustodyTransfer } from './artifact-custody-authority.js';
import type { CollectiveArtifactCustodyTransfer as TransferStore } from './artifact-custody-transfer.js';
import { ownerOperationError } from './artifact-relay.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './membership-authority.js';
import { createSecret, type PersistentServiceState } from './persistence.js';

interface PendingPage {
  key: string;
  stamp: string;
  operation: CollectiveCustodyPageOperation;
  promise: Promise<CollectiveCustodyPage>;
  resolve(value: CollectiveCustodyPage): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One short-lived page per request, bounded to 32 slots and 8 seconds; no durable payload or event outbox. */
export class CollectiveArtifactCustodyPages {
  private readonly pending = new Map<string, PendingPage>();
  private active = true;
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly transfers: TransferStore,
    private readonly now: () => number,
  ) {}
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
    for (const [ref, pending] of this.pending) this.fail(ref, pending, ownerOperationError('owner_unavailable'));
  }
  request(credential: string, raw: unknown): Promise<CollectiveCustodyPage> {
    if (!this.active) throw ownerOperationError('owner_unavailable');
    const { index, ...coordinates } = collectiveCustodyPageRequestSchema.parse(raw);
    const transfer = this.transfers.authorize(credential, { ...coordinates, operation: 'stageTarget' });
    if (!transfer.prepared || index >= transfer.prepared.manifest.pageCount) denyArtifact();
    const key = JSON.stringify([transfer.transferId, coordinates.connectionId, index]);
    for (const pending of this.pending.values()) if (pending.key === key) return pending.promise;
    if (this.pending.size >= 32) throw new CollectiveServiceError('ARTIFACT_BUSY', 'Custody page relay is busy', 429);
    const relayRef = `custody-page:${createSecret()}`;
    let resolve!: PendingPage['resolve'];
    let reject!: PendingPage['reject'];
    const promise = new Promise<CollectiveCustodyPage>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => this.fail(relayRef, pending, ownerOperationError('owner_unavailable')), 8000);
    timer.unref();
    const pending: PendingPage = {
      key,
      stamp: this.stamp(transfer),
      promise,
      resolve,
      reject,
      timer,
      operation: { relayRef, transfer: structuredClone(transfer), index, expiresAt: this.now() + 8000 },
    };
    this.pending.set(relayRef, pending);
    return promise;
  }
  poll(credential: string, raw: unknown): CollectiveCustodyPageOperation[] {
    const input = collectiveCustodyEndpointSchema.parse(raw);
    this.endpoint(credential, input);
    const operations: CollectiveCustodyPageOperation[] = [];
    for (const [ref, pending] of this.pending) {
      if (pending.operation.transfer.sourceConnectionId !== input.connectionId) continue;
      try {
        this.validate(credential, pending);
      } catch (error) {
        this.fail(ref, pending, error);
        continue;
      }
      operations.push(structuredClone(pending.operation));
      if (operations.length === 2) break;
    }
    return operations;
  }
  respond(credential: string, raw: unknown) {
    const input = collectiveCustodyPageResponseSchema.parse(raw);
    this.endpoint(credential, input);
    const pending = this.pending.get(input.relayRef);
    if (!pending || pending.operation.transfer.sourceConnectionId !== input.connectionId) denyArtifact();
    try {
      this.validate(credential, pending);
      if (input.status === 'ok') this.validatePage(pending.operation, input.page);
    } catch (error) {
      this.fail(input.relayRef, pending, error);
      throw error;
    }
    clearTimeout(pending.timer);
    this.pending.delete(input.relayRef);
    if (input.status === 'ok') pending.resolve(structuredClone(input.page));
    else pending.reject(ownerOperationError(input.error));
    return { acknowledged: true };
  }
  private validate(credential: string, pending: PendingPage) {
    const { transfer, expiresAt } = pending.operation;
    if (expiresAt <= this.now()) throw ownerOperationError('owner_unavailable');
    const fresh = this.transfers.authorize(credential, {
      serviceInstanceId: transfer.serviceInstanceId,
      collectiveId: transfer.collectiveId,
      artifactId: transfer.artifactId,
      connectionId: transfer.sourceConnectionId,
      transferId: transfer.transferId,
      operation: 'readPage',
    });
    if (
      fresh.state !== 'source_prepared' ||
      !isDeepStrictEqual(fresh.prepared, transfer.prepared) ||
      this.stamp(fresh) !== pending.stamp
    )
      denyArtifact();
  }
  private validatePage(operation: CollectiveCustodyPageOperation, page: CollectiveCustodyPage) {
    const bytes = Buffer.from(page.base64, 'base64');
    const manifest = operation.transfer.prepared?.manifest;
    if (
      !manifest ||
      page.transferId !== operation.transfer.transferId ||
      page.index !== operation.index ||
      bytes.byteLength !==
        Math.min(COLLECTIVE_CUSTODY_PAGE_BYTES, manifest.totalBytes - page.index * COLLECTIVE_CUSTODY_PAGE_BYTES) ||
      bytes.toString('base64') !== page.base64 ||
      page.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    )
      throw ownerOperationError('invalid_request');
  }
  private endpoint(
    credential: string,
    coordinates: { serviceInstanceId: string; collectiveId: string; connectionId: string },
  ) {
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, credential, coordinates.connectionId);
    assertConnectionCoordinates(state, connection, coordinates);
    requireAuthorizedHuman(state, connection);
  }
  private stamp(transfer: CollectiveArtifactCustodyTransfer) {
    const state = this.persistence.snapshot();
    const { artifact } = requireCustodyTransfer(state, transfer);
    return JSON.stringify([
      requireMembership(state, transfer.collectiveId, transfer.sourceHumanId).revision,
      requireMembership(state, transfer.collectiveId, transfer.targetHumanId).revision,
      artifactAccess(artifact, transfer.targetHumanId).revision,
    ]);
  }
  private fail(ref: string, pending: PendingPage, error: unknown) {
    clearTimeout(pending.timer);
    this.pending.delete(ref);
    pending.reject(error);
  }
}
