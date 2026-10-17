import { collectiveParticipationDeclarationSchema } from '../contracts/index.js';
import { createHash } from 'node:crypto';
import { ConnectorPersistence } from './persistence.js';
import { CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import type { LocalRecoveryProof, RecoveryOwnerContext } from './recovery-proof.js';
import type { ConnectorConnectionState, ConnectorState, DeepMutable, LocalAttempt } from './state.js';

export function semanticDigest(value: unknown): string {
  // Canonical object keys; array order remains semantic, including agent and event order.
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) :
    input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])) : input;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export function connectionIdentity(connection: ConnectorConnectionState): string {
  return semanticDigest([connection.serviceUrl, connection.serviceInstanceId, connection.collectiveId,
    connection.connectionId, connection.endpointId, connection.authorizedHumanId, connection.endpointCredential]);
}
export function recoveryRequired(reason = 'COLLECTIVE_RECOVERY_REQUIRED'): ConnectorTransportError {
  return new ConnectorTransportError('This operation needs verification in the plugin recovery rows', 409, reason,
    { code: reason, effect: 'unknown', automaticRetry: false });
}

/** Every local effect enters through an fsync'd attempt and a CAS settlement, never through a retry queue. */
export class LocalOperationRecovery {
  constructor(private readonly persistence: ConnectorPersistence, private readonly service: CollectiveServiceClient,
    private readonly now: () => number) {}

  async run<T>(connectionId: string, kind: LocalAttempt['kind'], semanticKey: string, payload: unknown,
    dispatch: () => Promise<T>, settle: (connection: DeepMutable<ConnectorConnectionState>, value: T) => void): Promise<T> {
    return this.runAttempt(connectionId, kind, semanticKey, payload, dispatch, settle);
  }

  private async assertOwner(connectionId: string, owner: RecoveryOwnerContext): Promise<void> {
    await owner.assertCurrent();
    if (!owner.userId || this.persistence.snapshot().hostRoutes[connectionId]?.localOwnerUserId !== owner.userId)
      throw recoveryRequired('RECOVERY_OWNER_REQUIRED');
  }

  async reconcile<T>(connectionId: string, operationId: string, expectedRevision: number, owner: RecoveryOwnerContext,
    obtainProof: () => Promise<LocalRecoveryProof<T>>, settle: (connection: DeepMutable<ConnectorConnectionState>, value: T) => void,
    assertIntent?: (state: ConnectorState) => void) {
    await this.assertOwner(connectionId, owner);
    const snapshot = this.persistence.snapshot().connections[connectionId];
    const attempt = snapshot?.localAttempts?.find(item => item.operationId === operationId);
    if (!snapshot || !attempt || attempt.status !== 'held' || attempt.revision !== expectedRevision ||
      connectionIdentity(snapshot) !== attempt.identityDigest) throw recoveryRequired();
    const proof = await obtainProof();
    await this.assertOwner(connectionId, owner); await this.service.assertLocalCurrent();
    return this.persistence.transaction(state => {
      const connection = state.connections[connectionId];
      const current = connection?.localAttempts?.find(item => item.operationId === operationId);
      if (!connection || !current || current.status !== 'held' || current.revision !== expectedRevision ||
        connectionIdentity(connection) !== attempt.identityDigest ||
        state.hostRoutes[connectionId]?.localOwnerUserId !== owner.userId) throw recoveryRequired();
      assertIntent?.(state);
      if (proof.outcome === 'confirmed') {
        settle(connection, proof.value); current.status = 'settled'; current.proof = 'confirmed';
        current.reason = 'LOCAL_RESULT_CONFIRMED';
      } else if (proof.outcome === 'replay_safe') {
        current.proof = 'replay_safe'; current.reason = 'LOCAL_REPLAY_SAFE';
      } else { current.reason = 'LOCAL_PROOF_UNRESOLVED'; }
      current.revision++; current.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(current);
    }, () => this.assertOwner(connectionId, owner));
  }

  async resume<T>(connectionId: string, operationId: string, expectedRevision: number, owner: RecoveryOwnerContext,
    kind: LocalAttempt['kind'], semanticKey: string, payload: unknown, dispatch: () => Promise<T>,
    settle: (connection: DeepMutable<ConnectorConnectionState>, value: T) => void): Promise<T> {
    await this.assertOwner(connectionId, owner);
    return this.runAttempt(connectionId, kind, semanticKey, payload, dispatch, settle, { operationId, expectedRevision, owner });
  }

  private async runAttempt<T>(connectionId: string, kind: LocalAttempt['kind'], semanticKey: string, payload: unknown,
    dispatch: () => Promise<T>, settle: (connection: DeepMutable<ConnectorConnectionState>, value: T) => void,
    resume?: { operationId: string; expectedRevision: number; owner: RecoveryOwnerContext }): Promise<T> {
    const initial = this.persistence.snapshot().connections[connectionId];
    if (!initial) throw recoveryRequired();
    if (!this.service.usesLocalTransport(initial.serviceUrl)) {
      const value = await dispatch();
      await this.persistence.transaction(state => settle(state.connections[connectionId]!, value));
      return value;
    }
    const identityDigest = connectionIdentity(initial), payloadDigest = semanticDigest(payload);
    const operationId = semanticDigest([identityDigest, kind, semanticKey, payloadDigest]);
    const timestamp = () => new Date(this.now()).toISOString();
    const attempt = await this.persistence.transaction(state => {
      const connection = state.connections[connectionId];
      if (!connection || connectionIdentity(connection) !== identityDigest ||
        (kind === 'revoke' ? connection.authorityStatus !== 'revoking' : connection.authorityStatus !== 'connected'))
        throw recoveryRequired();
      const attempts = connection.localAttempts ??= [];
      const pending = attempts.find(item => item.kind === kind && item.status !== 'settled');
      if (resume) {
        if (!pending || pending.operationId !== resume.operationId || pending.operationId !== operationId ||
          pending.revision !== resume.expectedRevision || pending.status !== 'held' || !['not_started', 'replay_safe'].includes(pending.proof) ||
          state.hostRoutes[connectionId]?.localOwnerUserId !== resume.owner.userId)
          throw recoveryRequired();
        pending.status = 'entered'; pending.generation++; pending.revision++;
        pending.effect = 'unknown'; pending.proof = 'unresolved';
        pending.reason = 'LOCAL_ATTEMPT_ENTERED'; pending.updatedAt = timestamp();
        return structuredClone(pending);
      }
      if (pending) throw recoveryRequired(kind === 'revoke' ? 'COLLECTIVE_REVOCATION_UNCONFIRMED' : undefined);
      const previous = attempts.find(item => item.operationId === operationId);
      if (previous) throw recoveryRequired(); // Success is settled by its original caller; never blindly replay it.
      const created: LocalAttempt = { operationId, kind, semanticKey, identityDigest, payloadDigest,
        revision: 1, generation: 1, status: 'entered', effect: 'unknown', proof: 'unresolved', reason: 'LOCAL_ATTEMPT_ENTERED',
        createdAt: timestamp(), updatedAt: timestamp() };
      if (kind === 'participation') {
        (connection.localParticipationIntents ??= {})[operationId] = collectiveParticipationDeclarationSchema.parse(payload);
      }
      attempts.push(created); return created;
    }, async () => { if (resume) await this.assertOwner(connectionId, resume.owner); await this.service.assertLocalCurrent(); });
    const hold = async (effect: LocalAttempt['effect'], reason: string) => {
      await this.persistence.transaction(state => {
        const current = state.connections[connectionId]?.localAttempts?.find(item => item.operationId === operationId);
        if (!current || current.revision !== attempt.revision || current.status !== 'entered') return;
        current.status = 'held'; current.effect = effect; current.proof = effect === 'not_started' ? 'not_started' : 'unresolved'; current.reason = reason;
        current.revision++; current.updatedAt = timestamp();
      });
    };
    try {
      if (resume) await this.assertOwner(connectionId, resume.owner);
      await this.service.assertLocalCurrent();
      const fresh = this.persistence.snapshot().connections[connectionId];
      if (!fresh || connectionIdentity(fresh) !== identityDigest ||
        (kind === 'revoke' ? fresh.authorityStatus !== 'revoking' : fresh.authorityStatus !== 'connected'))
        throw recoveryRequired();
      const value = await dispatch();
      if (resume) await this.assertOwner(connectionId, resume.owner);
      await this.service.assertLocalCurrent();
      await this.persistence.transaction(state => {
        const connection = state.connections[connectionId];
        const current = connection?.localAttempts?.find(item => item.operationId === operationId);
        if (!connection || !current || current.revision !== attempt.revision || current.status !== 'entered' ||
          connectionIdentity(connection) !== identityDigest ||
          (kind === 'revoke' ? connection.authorityStatus !== 'revoking' : connection.authorityStatus !== 'connected'))
          throw recoveryRequired();
        settle(connection, value);
        current.status = 'settled'; current.proof = 'confirmed'; current.revision++; current.reason = 'LOCAL_RESULT_CONFIRMED';
        current.updatedAt = timestamp();
      }, async () => { if (resume) await this.assertOwner(connectionId, resume.owner); await this.service.assertLocalCurrent(); });
      return value;
    } catch (error) {
      const effect = error instanceof ConnectorTransportError && error.automaticRetry === false ? error.effect ?? 'unknown' : 'unknown';
      const code = error instanceof ConnectorTransportError ? error.code : 'LOCAL_RESULT_UNCONFIRMED';
      await hold(effect, /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'LOCAL_RESULT_UNCONFIRMED');
      throw error;
    }
  }
}
