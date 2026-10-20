import type { CollectiveSourceIdentity } from '../contracts/index.js';
import { participationDeclaration, requireParticipation } from './participation-custody.js';
import { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import { CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import { outboxInput, outboxPayload, settleOutbox, settleAck, settleRevoke, recoveryIntent } from './local-recovery-intent.js';
import type { RecoveryOwnerContext } from './recovery-proof.js';
import { LocalOperationRecovery, semanticDigest, connectionIdentity, recoveryRequired } from './local-operation-recovery.js';
import type { ConnectorConnectionState } from './state.js';
import type { ConnectorWorkAcceptanceCustody } from './work-acceptance-custody.js';
import { revalidateQueuedWork } from './work-outbound-authority.js';

export interface ConnectorSyncHooks {
  readonly afterInboxPersist?: () => void | Promise<void>;
}

export class ConnectorSynchronization {
  private readonly localRecovery: LocalOperationRecovery;
  readonly #syncs = new Map<string, Promise<ConnectorProjection>>();

  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly now: () => number,
    private readonly currentWorkGrant?: (
      source: CollectiveSourceIdentity,
    ) => ReturnType<ConnectorWorkAcceptanceCustody['resolveGrant']>,
  ) { this.localRecovery = new LocalOperationRecovery(persistence, service, now); }

  sync(connectionId: string, hooks: ConnectorSyncHooks = {}): Promise<ConnectorProjection> {
    const existing = this.#syncs.get(connectionId);
    if (existing) return existing;
    const running = this.performSync(connectionId, hooks).finally(() => {
      if (this.#syncs.get(connectionId) === running) this.#syncs.delete(connectionId);
    });
    this.#syncs.set(connectionId, running);
    return running;
  }

  async revoke(connectionId: string): Promise<ConnectorProjection> {
    await this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      if (connection.authorityStatus === 'revoked') return;
      connection.authorityStatus = 'revoking';
    });
    return this.finishRevoke(connectionId);
  }

  async publishParticipation(connectionId: string): Promise<void> {
    const state = this.persistence.snapshot();
    const connection = requireConnection(state.connections[connectionId]);
    const route = state.hostRoutes[connectionId];
    if (!route || connection.authorityStatus !== 'connected') throw new Error('Participation is not configured');
    const declaration = participationDeclaration(connection, route);
    if (this.service.usesLocalTransport(connection.serviceUrl)) {
      const previous = connection.localAttempts?.find(item => item.kind === 'participation' && item.status !== 'settled');
      if (previous) throw recoveryRequired();
      if (connection.localAttempts?.some(item => item.kind === 'participation' && item.status === 'settled' &&
        item.identityDigest === connectionIdentity(connection) && item.payloadDigest === semanticDigest(declaration))) return;
    }
    await this.localRecovery.run(connectionId, 'participation', String(declaration.revision), declaration,
      () => this.service.publishParticipation(connection.serviceUrl, requireCredential(connection), declaration), () => {});
  }

  async recover(connectionId: string, operationId: string, expectedRevision: number,
    mode: 'reconcile' | 'resume', owner: RecoveryOwnerContext): Promise<ConnectorProjection> {
    // Authorization precedes proof reads, not merely the final write.
    await owner.assertCurrent();
    const state = this.persistence.snapshot();
    if (state.hostRoutes[connectionId]?.localOwnerUserId !== owner.userId) throw recoveryRequired('RECOVERY_OWNER_REQUIRED');
    const attempt = state.connections[connectionId]?.localAttempts?.find(item => item.operationId === operationId);
    if (!attempt || attempt.status !== 'held' || attempt.revision !== expectedRevision) throw recoveryRequired();
    const intent = recoveryIntent(state, connectionId, attempt, this.service);
    if (mode === 'reconcile') {
      await this.localRecovery.reconcile(connectionId, operationId, expectedRevision, owner, intent.proof, intent.settle,
        current => { recoveryIntent(current, connectionId, attempt, this.service); });
    } else {
      await this.localRecovery.resume(connectionId, operationId, expectedRevision, owner, attempt.kind,
        attempt.semanticKey, intent.payload, async () => {
          if (attempt.kind === 'outbox') {
            const currentState = this.persistence.snapshot();
            const connection = requireConnection(currentState.connections[connectionId]);
            const pending = connection.outbox.find(item => item.outboxId + ':' + item.clientEventId === attempt.semanticKey);
            if (!pending || (pending.workPurpose && (!pending.replySource || !this.currentWorkGrant)))
              throw recoveryRequired('WORK_RECOVERY_AUTHORITY_REQUIRED');
            if (pending.replySource) {
              requireParticipation(currentState, pending.replySource);
              const context = await this.service.readParticipationContext(connection.serviceUrl, requireCredential(connection), pending.replySource, 0, 1);
              await revalidateQueuedWork(this.service, connection, pending, context.source, this.currentWorkGrant);
              requireParticipation(this.persistence.snapshot(), pending.replySource);
            }
          }
          await owner.assertCurrent();
          const current = this.persistence.snapshot();
          const freshIntent = recoveryIntent(current, connectionId, attempt, this.service);
          return freshIntent.dispatch();
        }, intent.settle);
    }
    const current = this.persistence.snapshot();
    return projectConnection(requireConnection(current.connections[connectionId]), current.hostRoutes[connectionId]);
  }

  private async performSync(connectionId: string, hooks: ConnectorSyncHooks): Promise<ConnectorProjection> {
    const initialSnapshot = this.persistence.snapshot();
    const initial = requireConnection(initialSnapshot.connections[connectionId]);
    if (initial.authorityStatus === 'revoked') {
      return projectConnection(initial, initialSnapshot.hostRoutes[connectionId]);
    }
    if (initial.authorityStatus === 'revoking') return this.finishRevoke(connectionId);
    const hostRoute = initialSnapshot.hostRoutes[connectionId];
    if (hostRoute) {
      try {
        await this.publishParticipation(connectionId);
      } catch (error) {
        if (!(error instanceof ConnectorTransportError)) throw error;
        return this.recordTransportFailure(connectionId, error);
      }
    }
    if (initial.pendingAckSequence !== undefined) {
      try {
        await this.finishPendingAck(connectionId);
      } catch (error) {
        if (!(error instanceof ConnectorTransportError)) throw error;
        return this.recordTransportFailure(connectionId, error);
      }
    }
    const hadPendingOutbox = initial.outbox.some((item) => item.status === 'queued' || item.status === 'sending');
    const flushed = await this.flushOutbox(connectionId);
    // Polling is the reconnect probe when no outbound item was attempted.
    if (hadPendingOutbox && flushed.liveStatus === 'offline') return flushed;
    const current = requireConnection(this.persistence.snapshot().connections[connectionId]);
    try {
      const delivery = await this.service.poll(current.serviceUrl, requireCredential(current), {
        serviceInstanceId: current.serviceInstanceId,
        collectiveId: current.collectiveId,
        connectionId: current.connectionId,
        afterSequence: current.lastAckedSequence,
        limit: 100,
      });
      await this.persistence.transaction((state) => {
        const connection = requireConnection(state.connections[connectionId]);
        const known = new Set(connection.inbox.map((item) => item.event.eventId));
        for (const event of delivery.events) {
          if (known.has(event.eventId)) continue;
          connection.inbox.push({
            event,
            disposition: 'persisted',
            persistedAt: new Date(this.now()).toISOString(),
          });
          known.add(event.eventId);
        }
        connection.liveStatus = 'online';
        delete connection.lastError;
        delete connection.lastErrorCode;
      });
      await hooks.afterInboxPersist?.();
      return await this.acknowledgeContiguous(connectionId);
    } catch (error) {
      if (!(error instanceof ConnectorTransportError)) throw error;
      return this.recordTransportFailure(connectionId, error);
    }
  }

  private async flushOutbox(connectionId: string): Promise<ConnectorProjection> {
    while (true) {
      const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
      if (snapshot.authorityStatus !== 'connected')
        return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
      const pending = snapshot.outbox.find((item) => item.status === 'queued' || item.status === 'sending');
      if (!pending) return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
      if (pending.replySource) {
        try {
          requireParticipation(this.persistence.snapshot(), pending.replySource);
          const context = await this.service.readParticipationContext(
            snapshot.serviceUrl,
            requireCredential(snapshot),
            pending.replySource,
            0,
            1,
          );
          await revalidateQueuedWork(this.service, snapshot, pending, context.source, this.currentWorkGrant);
          requireParticipation(this.persistence.snapshot(), pending.replySource);
        } catch (error) {
          const code =
            error instanceof ConnectorTransportError
              ? error.causeCode
              : error && typeof error === 'object' && 'code' in error
                ? error.code
                : undefined;
          if (
            code === 'PARTICIPATION_REVOKED' ||
            code === 'CONNECTION_REVOKED' ||
            code === 'RETURN_UNAVAILABLE' ||
            code === 'FORBIDDEN' ||
            code === 'WORK_EXECUTION_NOT_CURRENT' ||
            code === 'WORK_DELEGATION_UNAVAILABLE' ||
            code === 'WORK_ADMISSION_NOT_CURRENT' ||
            code === 'WORK_RESULT_NOT_CURRENT'
          ) {
            await this.persistence.transaction((state) => {
              const item = state.connections[connectionId]?.outbox.find(
                (candidate) => candidate.outboxId === pending.outboxId,
              );
              if (item) {
                item.status = 'blocked';
                item.failureCode = code;
              }
            });
            if (code === 'CONNECTION_REVOKED' && !this.service.usesLocalTransport(snapshot.serviceUrl))
              return this.markServiceRevoked(connectionId);
            continue;
          }
          return this.markOffline(
            connectionId,
            'Public source could not be revalidated',
            typeof code === 'string' ? code : undefined,
          );
        }
      }
      if (!pending.agent) throw new Error('Queued outbox item has no named author');
      await this.persistence.transaction((state) => {
        const item = requireConnection(state.connections[connectionId]).outbox.find(
          (candidate) => candidate.outboxId === pending.outboxId,
        );
        if (item) item.status = 'sending';
      });
      try {
        const input = outboxInput(snapshot, pending);
        await this.localRecovery.run(connectionId, 'outbox', pending.outboxId + ':' + pending.clientEventId,
          outboxPayload(snapshot, pending), () => this.service.postAgentMessage(snapshot.serviceUrl, requireCredential(snapshot), input),
          (connection, event) => settleOutbox(connection, pending, event));
      } catch (error) {
        if (!(error instanceof ConnectorTransportError)) throw error;
        const refused = [
          'WORK_EXECUTION_NOT_CURRENT',
          'WORK_DELEGATION_UNAVAILABLE',
          'WORK_ADMISSION_NOT_CURRENT',
          'WORK_RESULT_NOT_CURRENT',
          'PARTICIPATION_REVOKED',
          'RETURN_UNAVAILABLE',
        ].includes(error.causeCode ?? '');
        await this.persistence.transaction((state) => {
          const item = requireConnection(state.connections[connectionId]).outbox.find(
            (candidate) => candidate.outboxId === pending.outboxId,
          );
          if (item) {
            item.status = refused ? 'blocked' : 'queued';
            if (refused) item.failureCode = error.causeCode;
          }
        });
        if (refused) continue;
        return this.recordTransportFailure(connectionId, error);
      }
    }
  }

  private async acknowledgeContiguous(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const sequences = new Set(snapshot.inbox.map((item) => item.event.sequence));
    let sequence = snapshot.lastAckedSequence;
    while (sequences.has(sequence + 1)) sequence += 1;
    if (sequence === snapshot.lastAckedSequence) {
      return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
    }
    await this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.pendingAckSequence = Math.max(connection.pendingAckSequence ?? 0, sequence);
    });
    return this.finishPendingAck(connectionId);
  }

  private async finishPendingAck(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const sequence = snapshot.pendingAckSequence;
    if (sequence === undefined) {
      return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
    }
    await this.localRecovery.run(connectionId, 'ack', String(sequence), {
      serviceInstanceId: snapshot.serviceInstanceId, collectiveId: snapshot.collectiveId, connectionId, sequence,
    }, () => this.service.acknowledge(snapshot.serviceUrl, requireCredential(snapshot), {
      serviceInstanceId: snapshot.serviceInstanceId, collectiveId: snapshot.collectiveId, connectionId, sequence,
    }), connection => settleAck(connection, sequence));
    const current = this.persistence.snapshot();
    return projectConnection(requireConnection(current.connections[connectionId]), current.hostRoutes[connectionId]);
  }

  private async finishRevoke(connectionId: string): Promise<ConnectorProjection> {
    const persisted = this.persistence.snapshot();
    const snapshot = requireConnection(persisted.connections[connectionId]);
    if (snapshot.authorityStatus === 'revoked') {
      return projectConnection(snapshot, persisted.hostRoutes[connectionId]);
    }
    if (this.service.usesLocalTransport(snapshot.serviceUrl)) {
      try {
        await this.localRecovery.run(connectionId, 'revoke', 'authority', {
          serviceInstanceId: snapshot.serviceInstanceId, collectiveId: snapshot.collectiveId, connectionId,
        }, () => this.service.revoke(snapshot.serviceUrl, requireCredential(snapshot), {
          serviceInstanceId: snapshot.serviceInstanceId, collectiveId: snapshot.collectiveId, connectionId,
        }), connection => settleRevoke(connection));
      } catch (error) {
        return this.markOffline(connectionId, 'Revocation was requested but remains unconfirmed; use the plugin recovery rows',
          'COLLECTIVE_REVOCATION_UNCONFIRMED');
      }
      const current = this.persistence.snapshot();
      return projectConnection(requireConnection(current.connections[connectionId]), current.hostRoutes[connectionId]);
    }
    try {
      await this.service.revoke(snapshot.serviceUrl, requireCredential(snapshot), {
        serviceInstanceId: snapshot.serviceInstanceId,
        collectiveId: snapshot.collectiveId,
        connectionId: snapshot.connectionId,
      });
    } catch (error) {
      if (
        error instanceof ConnectorTransportError &&
        error.statusCode === 409 &&
        error.causeCode === 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED'
      ) {
        await this.persistence.transaction((state) => {
          const connection = requireConnection(state.connections[connectionId]);
          connection.authorityStatus = 'connected';
          connection.lastError = error.message;
          connection.lastErrorCode = error.causeCode;
        });
        throw error;
      }
      if (
        !(error instanceof ConnectorTransportError) ||
        error.statusCode !== 401 ||
        !error.message.toLowerCase().includes('revoked')
      ) {
        return this.markOffline(
          connectionId,
          error instanceof Error ? error.message : 'Revoke failed',
          error instanceof ConnectorTransportError ? error.causeCode : undefined,
        );
      }
    }
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.authorityStatus = 'revoked';
      connection.revocationReason = 'owner_revoked';
      connection.liveStatus = 'offline';
      delete connection.endpointCredential;
      delete connection.lastError;
      delete connection.lastErrorCode;
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }

  private async markOffline(connectionId: string, message: string, errorCode?: string): Promise<ConnectorProjection> {
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.liveStatus = 'offline';
      connection.lastError = message;
      if (errorCode) connection.lastErrorCode = errorCode;
      else delete connection.lastErrorCode;
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }

  private recordTransportFailure(connectionId: string, error: ConnectorTransportError): Promise<ConnectorProjection> {
    const connection = this.persistence.snapshot().connections[connectionId];
    return error.causeCode === 'CONNECTION_REVOKED' && connection && !this.service.usesLocalTransport(connection.serviceUrl)
      ? this.markServiceRevoked(connectionId)
      : this.markOffline(connectionId, error.message, error.causeCode);
  }

  private markServiceRevoked(connectionId: string): Promise<ConnectorProjection> {
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.authorityStatus = 'revoked';
      connection.revocationReason = 'service_revoked';
      connection.liveStatus = 'offline';
      delete connection.endpointCredential;
      delete connection.pendingAckSequence;
      delete connection.lastError;
      delete connection.lastErrorCode;
      for (const item of connection.outbox) {
        if (item.status !== 'queued' && item.status !== 'sending') continue;
        item.status = 'blocked';
        item.failureCode = 'CONNECTION_REVOKED';
      }
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}

function requireCredential(connection: ConnectorConnectionState): string {
  if (!connection.endpointCredential) throw new Error('Endpoint credential is unavailable');
  return connection.endpointCredential;
}
