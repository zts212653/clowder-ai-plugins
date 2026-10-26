import type { CollectiveAgentMessageRequest, CollectiveEventEnvelope } from '../contracts/index.js';
import type { CollectiveServiceClient } from './service-client.js';
import type { ConnectorConnectionState, ConnectorOutboxItem, ConnectorState, DeepMutable, LocalAttempt } from './state.js';
import type { LocalRecoveryProof } from './recovery-proof.js';
import { connectionIdentity, recoveryRequired, semanticDigest } from './local-operation-recovery.js';
import { workOutboundIntent, workOutboundReceipt } from './work-outbound-authority.js';

export function outboxInput(connection: ConnectorConnectionState, pending: ConnectorOutboxItem): CollectiveAgentMessageRequest {
  if (!pending.agent) throw new Error('Queued outbox item has no named author');
  return { serviceInstanceId: connection.serviceInstanceId, collectiveId: connection.collectiveId,
    connectionId: connection.connectionId, clientEventId: pending.clientEventId, agent: pending.agent, target: pending.target,
    ...(pending.location ? { location: pending.location, recipient: { kind: 'channel' as const } } : {}),
    ...(pending.replySource ? { participationRevision: pending.replySource.participationRevision } : {}),
    ...(pending.replyToEventId ? { replyToEventId: pending.replyToEventId } : {}),
    ...(pending.attachments ? { attachments: pending.attachments } : {}),
    ...(pending.contextAttachments ? { contextAttachments: pending.contextAttachments } : {}),
    ...(pending.richBlocks ? { richBlocks: pending.richBlocks } : {}),
    ...workOutboundIntent(pending), body: pending.body };
}
export function outboxPayload(connection: ConnectorConnectionState, pending: ConnectorOutboxItem) {
  return { input: outboxInput(connection, pending), workPurpose: pending.workPurpose, replySource: pending.replySource,
    operationKey: pending.operationKey };
}
export function settleOutbox(connection: DeepMutable<ConnectorConnectionState>, pending: ConnectorOutboxItem, event: CollectiveEventEnvelope) {
  const receipt = workOutboundReceipt(event, pending);
  const item = connection.outbox.find(candidate => candidate.outboxId === pending.outboxId);
  if (!item || semanticDigest(outboxPayload(connection, item)) !== semanticDigest(outboxPayload(connection, pending)))
    throw recoveryRequired();
  item.status = 'accepted'; item.acceptedEventId = event.eventId;
  if (item.workPurpose && receipt) item.workPurpose.workId = receipt.workId;
  if (connection.authorityStatus === 'connected') {
    connection.liveStatus = 'online'; delete connection.lastError; delete connection.lastErrorCode;
  }
}
export function settleAck(connection: DeepMutable<ConnectorConnectionState>, sequence: number) {
  connection.lastAckedSequence = Math.max(connection.lastAckedSequence, sequence);
  if (connection.pendingAckSequence === sequence) delete connection.pendingAckSequence;
  if (connection.authorityStatus === 'connected') {
    connection.liveStatus = 'online'; delete connection.lastError; delete connection.lastErrorCode;
  }
}
export function settleRevoke(connection: DeepMutable<ConnectorConnectionState>) {
  connection.authorityStatus = 'revoked'; connection.revocationReason = 'owner_revoked'; connection.liveStatus = 'offline';
  delete connection.endpointCredential; delete connection.lastError; delete connection.lastErrorCode;
}
function contiguous(connection: ConnectorConnectionState, target: number) {
  const sequences = new Set(connection.inbox.map(item => item.event.sequence));
  for (let sequence = connection.lastAckedSequence + 1; sequence <= target; sequence++) if (!sequences.has(sequence)) return false;
  return true;
}
/** Reconstruct original durable intent; current coordinates/payload must still match its fence. */
export function recoveryIntent(state: ConnectorState, connectionId: string, attempt: LocalAttempt, service: CollectiveServiceClient) {
  const connection = state.connections[connectionId];
  if (!connection || !connection.endpointCredential || connectionIdentity(connection) !== attempt.identityDigest)
    throw recoveryRequired();
  const credential = connection.endpointCredential;
  const coordinates = { serviceInstanceId: connection.serviceInstanceId, collectiveId: connection.collectiveId, connectionId };
  let payload: unknown;
  let dispatch: () => Promise<unknown>;
  let settle: (connection: DeepMutable<ConnectorConnectionState>, value: unknown) => void;
  let proof: () => Promise<LocalRecoveryProof<unknown>>;
  if (attempt.kind === 'outbox') {
    const pending = connection.outbox.find(item => item.outboxId + ':' + item.clientEventId === attempt.semanticKey);
    if (!pending) throw recoveryRequired();
    const input = outboxInput(connection, pending); payload = outboxPayload(connection, pending);
    dispatch = () => service.postAgentMessage(connection.serviceUrl, credential, input);
    settle = (current, value) => settleOutbox(current, pending, value as CollectiveEventEnvelope);
    // Full Work side effects are not certified by the event index. Keep that case unresolved.
    proof = async () => {
      const snapshot = await service.readLocalRecovery(connection, pending.clientEventId);
      const event = snapshot.event;
      if (!event || pending.workPurpose || input.workResultIntent || input.workProgressIntent || pending.replySource ||
        event.workResultReceipt || event.workProgressReceipt || event.actor.kind !== 'agent') return { outcome: 'unresolved' };
      const actor = event.actor;
      if (event.body !== pending.body || event.clientEventId !== pending.clientEventId ||
        semanticDigest(event.attachments ?? []) !== semanticDigest(pending.attachments ?? []) ||
        semanticDigest(event.contextAttachments ?? []) !== semanticDigest(pending.contextAttachments ?? []) ||
        semanticDigest(event.richBlocks ?? []) !== semanticDigest(pending.richBlocks ?? []) ||
        event.replyToEventId !== pending.replyToEventId || actor.human.humanId !== connection.authorizedHumanId ||
        actor.provenance.connectionId !== connectionId || actor.provenance.endpointId !== connection.endpointId ||
        actor.provenance.catId !== pending.agent?.catId || actor.provenance.sessionRef !== pending.agent?.sessionRef ||
        actor.agent.agentId !== pending.agent?.agentId || actor.agent.displayName !== pending.agent?.displayName ||
        semanticDigest(event.target) !== semanticDigest(pending.target) ||
        (pending.location && semanticDigest(event.location) !== semanticDigest(pending.location))) return { outcome: 'unresolved' };
      return { outcome: 'confirmed', value: event };
    };
  } else if (attempt.kind === 'ack') {
    const sequence = Number(attempt.semanticKey);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !contiguous(connection, sequence)) throw recoveryRequired();
    payload = { ...coordinates, sequence };
    dispatch = () => service.acknowledge(connection.serviceUrl, credential, { ...coordinates, sequence });
    settle = current => settleAck(current, sequence);
    proof = async () => {
      const snapshot = await service.readLocalRecovery(connection);
      if (snapshot.lastAckedSequence >= sequence) return { outcome: 'confirmed', value: undefined };
      // The source ACK transaction assigns the same watermark, bounded by actual delivered order.
      return { outcome: snapshot.status === 'connected' && snapshot.lastDeliveredSequence >= sequence ? 'replay_safe' : 'unresolved' };
    };
  } else if (attempt.kind === 'participation') {
    const declaration = connection.localParticipationIntents?.[attempt.operationId];
    if (!declaration) throw recoveryRequired(); payload = declaration;
    dispatch = () => {
      if (state.hostRoutes[connectionId]?.revision !== declaration.revision) throw recoveryRequired();
      return service.publishParticipation(connection.serviceUrl, credential, declaration);
    };
    settle = () => {};
    proof = async () => {
      const snapshot = await service.readLocalRecovery(connection);
      return snapshot.declaration && semanticDigest(snapshot.declaration) === attempt.payloadDigest
        ? { outcome: 'confirmed', value: snapshot.declaration } : { outcome: 'unresolved' };
    };
  } else {
    payload = coordinates; dispatch = () => service.revoke(connection.serviceUrl, credential, coordinates);
    settle = current => settleRevoke(current);
    proof = async () => {
      const snapshot = await service.readLocalRecovery(connection);
      return snapshot.status === 'revoked' ? { outcome: 'confirmed', value: undefined } : { outcome: 'unresolved' };
    };
  }
  if (semanticDigest(payload) !== attempt.payloadDigest) throw recoveryRequired();
  return { payload, dispatch, settle, proof };
}
