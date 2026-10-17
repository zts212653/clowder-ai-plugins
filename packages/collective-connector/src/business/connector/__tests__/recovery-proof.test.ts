import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../../service/store.js';
import { ConnectorPersistence } from '../persistence.js';
import { CollectiveServiceClient, ConnectorTransportError } from '../service-client.js';
import { LocalOperationRecovery } from '../local-operation-recovery.js';
import { recoveryIntent, outboxInput, outboxPayload } from '../local-recovery-intent.js';
import { hostRouteConfigSchema } from '../host-route-state.js';
import { participationDeclaration } from '../participation-custody.js';
import type { LocalAttempt, ConnectorOutboxItem } from '../state.js';
import { CollectiveConnector } from '../connector.js';
import { createRecoveryActions } from '../../../recovery-actions.js';
import { BROWSER_SERVICE_LIMITS, type BrowserServiceBinding, type PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { validateOperationRowsResult } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const lost = () => new ConnectorTransportError('Response lost after effect', 504, 'BROWSER_SERVICE_TIMEOUT',
  { code: 'BROWSER_SERVICE_TIMEOUT', effect: 'unknown', automaticRetry: false });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'collective-real-proof-')); dirs.push(dir);
  const opened = await CollectiveServiceStore.open({ dataDirectory: join(dir, 'service'), humanAuthProvider: {
    id: 'github', readiness: { ready: true }, authorizationUrl: () => 'https://github.test/auth',
    async authenticate() { return { providerSubject: 'owner', handle: 'owner', displayName: 'Owner' }; },
  } });
  const store = opened.store;
  const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret!, displayName: 'Owner' });
  const login = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken: owner.sessionToken });
  const completion = await store.completeHumanAuth({ provider: 'github', state: login.state, code: 'code' });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: 'Proof fixture' });
  const pair = await store.createPairingIntent({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5172', nonce: 'proof-nonce-at-least-sixteen' });
  const connection = await store.exchangePairingIntent({ ...pair, endpointLabel: 'Proof host' });
  const id = connection.connectionId;
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId, connectionId: id };
  const persistence = await ConnectorPersistence.open(join(dir, 'connector'));
  await persistence.transaction(state => {
    state.connections[id] = { ...connection, serviceUrl: 'http://127.0.0.1:5271', clientBuildId: 'collective-client-v2',
      endpointLabel: 'Proof host', authorityStatus: 'connected', liveStatus: 'online', lastAckedSequence: 0, outbox: [], inbox: [], createdAt: new Date().toISOString() };
    // Pairing response contains only canonical connector fields; schema catches any accidental extras.
    state.hostRoutes[id] = hostRouteConfigSchema.parse({ connectionId: id, localOwnerUserId: 'owner',
      defaultIngressThreadId: 'thread', humanNotificationThreadId: 'thread', agentRoutes: {}, revision: 1, updatedAt: new Date().toISOString() });
  });
  const service = new CollectiveServiceClient(async () => { throw new Error('Network forbidden'); });
  Object.defineProperty(service, 'usesLocalTransport', { value: () => true });
  service.readLocalRecovery = async (_connection, clientEventId) => store.readLocalRecoverySnapshot(connection.endpointCredential,
    { ...coordinates, endpointId: connection.endpointId, authorizedHumanId: connection.authorizedHumanId }, clientEventId);
  const driver = new LocalOperationRecovery(persistence, service, Date.now);
  const current = () => persistence.snapshot().connections[id];
  const latest = () => current().localAttempts!.at(-1)!;
  const reconcile = (attempt: LocalAttempt) => {
    const intent = recoveryIntent(persistence.snapshot(), id, attempt, service);
    return driver.reconcile(id, attempt.operationId, attempt.revision, { userId: 'owner', async assertCurrent() {} },
      intent.proof, intent.settle, state => { recoveryIntent(state, id, attempt, service); });
  };
  return { dir, store, persistence, service, driver, id, coordinates, connection, current, latest, reconcile };
}
function pending(): ConnectorOutboxItem {
  return { outboxId: 'outbox-proof', clientEventId: 'same-event', agent: { agentId: 'sol', displayName: 'Sol', catId: 'sol', sessionRef: 'session:proof' },
    target: { kind: 'channel', channelId: 'general' }, body: 'Original exact body', status: 'sending', createdAt: new Date().toISOString() };
}
it('confirms the actual committed plain event after response loss, but not dedup with incomplete Work effects', async () => {
  const f = await fixture(); const item = pending();
  await f.persistence.transaction(state => { state.connections[f.id].outbox.push(item); });
  await expect(f.driver.run(f.id, 'outbox', item.outboxId + ':' + item.clientEventId, outboxPayload(f.current(), item), async () => {
    await f.store.postAgentMessage(f.connection.endpointCredential, outboxInput(f.current(), item)); throw lost();
  }, () => {})).rejects.toThrow();
  expect((await f.reconcile(f.latest())).status).toBe('settled');
  expect(f.current().outbox[0]).toMatchObject({ status: 'accepted' });
  const partial = { ...item, outboxId: 'work-outbox', workPurpose: { taskRef: 'task:work:fixture', admittedRevision: 1, resultRevision: 1 } };
  await f.persistence.transaction(state => { state.connections[f.id].outbox.push(partial); });
  await expect(f.driver.run(f.id, 'outbox', partial.outboxId + ':' + partial.clientEventId, outboxPayload(f.current(), partial),
    async () => { throw lost(); }, () => {})).rejects.toThrow();
  expect((await f.reconcile(f.latest())).status).toBe('held');
  expect(f.current().outbox[1].status).toBe('sending');
});
it('ACK proof distinguishes delivered from committed watermark and retains a newer pending target', async () => {
  const f = await fixture(); const item = pending();
  const event = await f.store.postAgentMessage(f.connection.endpointCredential, outboxInput(f.current(), item));
  await f.store.pollEvents(f.connection.endpointCredential, { ...f.coordinates, afterSequence: 0, limit: 100 });
  await f.persistence.transaction(state => { state.connections[f.id].inbox.push({ event, disposition: 'persisted', persistedAt: new Date().toISOString() });
    state.connections[f.id].pendingAckSequence = 1; });
  await expect(f.driver.run(f.id, 'ack', '1', { ...f.coordinates, sequence: 1 }, async () => { throw lost(); }, () => {})).rejects.toThrow();
  const replay = await f.reconcile(f.latest()); expect(replay).toMatchObject({ status: 'held', proof: 'replay_safe' });
  const read = f.service.readLocalRecovery.bind(f.service);
  f.service.readLocalRecovery = async (...args) => {
    const proof = await read(...args);
    await f.persistence.transaction(state => { state.connections[f.id].inbox = []; });
    return proof;
  };
  await expect(f.reconcile(f.latest())).rejects.toThrow();
  expect(f.current().lastAckedSequence).toBe(0);
  f.service.readLocalRecovery = read;
  await f.persistence.transaction(state => { state.connections[f.id].inbox.push({ event, disposition: 'persisted', persistedAt: new Date().toISOString() }); });
  await f.store.acknowledge(f.connection.endpointCredential, { ...f.coordinates, sequence: 1 });
  await f.persistence.transaction(state => { state.connections[f.id].pendingAckSequence = 2; });
  expect((await f.reconcile(f.latest())).status).toBe('settled');
  expect(f.current()).toMatchObject({ lastAckedSequence: 1, pendingAckSequence: 2 });
});
it('participation proof requires the full original declaration and a newer revision stays unresolved', async () => {
  const f = await fixture(); const declaration = participationDeclaration(f.current(), f.persistence.snapshot().hostRoutes[f.id]);
  await expect(f.driver.run(f.id, 'participation', '1', declaration, async () => {
    await f.store.publishParticipation(f.connection.endpointCredential, declaration); throw lost();
  }, () => {})).rejects.toThrow();
  expect((await f.reconcile(f.latest())).status).toBe('settled');
  await f.persistence.transaction(state => { state.hostRoutes[f.id].revision = 2; });
  const newer = { ...declaration, revision: 2 };
  await expect(f.driver.run(f.id, 'participation', '2', newer, async () => {
    await f.store.publishParticipation(f.connection.endpointCredential, newer); throw lost();
  }, () => {})).rejects.toThrow();
  await f.store.publishParticipation(f.connection.endpointCredential, { ...declaration, revision: 3 });
  expect((await f.reconcile(f.latest())).status).toBe('held');
});
it('actual revoked-record proof settles a lost revoke without re-entering the write', async () => {
  const f = await fixture(); await f.persistence.transaction(state => { state.connections[f.id].authorityStatus = 'revoking'; });
  await expect(f.driver.run(f.id, 'revoke', 'revoke', f.coordinates, async () => {
    await f.store.revokeOwnConnection(f.connection.endpointCredential, f.coordinates); throw lost();
  }, () => {})).rejects.toThrow();
  expect((await f.reconcile(f.latest())).status).toBe('settled');
  expect(f.current().authorityStatus).toBe('revoked'); expect(f.current().endpointCredential).toBeUndefined();
});

it('real recovery rows are read-only, owner-scoped and reconcile through exact declared tuple without body authority', async () => {
  const f = await fixture(); const item = pending();
  await f.persistence.transaction(state => { state.connections[f.id].outbox.push(item); });
  await expect(f.driver.run(f.id, 'outbox', item.outboxId + ':' + item.clientEventId, outboxPayload(f.current(), item), async () => {
    await f.store.postAgentMessage(f.connection.endpointCredential, outboxInput(f.current(), item)); throw lost();
  }, () => {})).rejects.toThrow();
  let effects = 0;
  const connector = await CollectiveConnector.open({ dataDirectory: join(f.dir, 'connector'), verifyAgent: async () => false,
    fetchImpl: async () => { throw new Error('Network forbidden'); }, localTransport: { matches: () => true, async assertCurrent() {},
      async fetch() { effects++; throw new Error('Reconciliation must not dispatch'); },
      async readRecovery(connection, clientEventId) { return f.store.readLocalRecoverySnapshot(connection.endpointCredential!, {
        serviceInstanceId: connection.serviceInstanceId, collectiveId: connection.collectiveId, connectionId: connection.connectionId,
        endpointId: connection.endpointId, authorizedHumanId: connection.authorizedHumanId!,
      }, clientEventId); },
    } });
  const binding: BrowserServiceBinding = { contributionId: 'collective-client-api', origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
    clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} };
  const context = (actionId: string, userId = 'owner'): PluginOwnerOperationContext => ({ kind: 'owner-operation', userId,
    pluginInstanceId: 'instance', operationKey: 'recovery', actionId, requestId: 'owner-request', signal: new AbortController().signal, async assertCurrent() {} });
  const actions = createRecoveryActions(connector, binding);
  const bytes = await readFile(join(f.dir, 'connector/collective-connector.json'));
  const listed = await actions['collective.recovery.list']({}, undefined, context('list')) as { data: { rows: Array<{ actions: Array<{ input: unknown; action: string }> }> } };
  expect(listed.data.rows).toHaveLength(1); expect(listed.data.rows[0].actions.map(action => action.action)).toEqual(['reconcile']);
  const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
  const operation = manifest.configuration.find((field: { key: string }) => field.key === 'recovery');
  expect(validateOperationRowsResult(operation, listed.data).valid).toBe(true);
  expect(JSON.stringify(listed)).not.toContain(f.connection.endpointCredential); expect(JSON.stringify(listed)).not.toContain(item.body);
  expect((await actions['collective.recovery.list']({}, undefined, context('list', 'stranger')) as typeof listed).data.rows).toHaveLength(0);
  expect(await readFile(join(f.dir, 'connector/collective-connector.json'))).toEqual(bytes);
  const input = listed.data.rows[0].actions[0].input;
  await expect(actions['collective.recovery.reconcile']!({ input }, undefined, context('resume'))).rejects.toThrow('owner operation');
  await expect(actions['collective.recovery.reconcile']!({ input: { ...input as object, userId: 'owner' } }, undefined, context('reconcile'))).rejects.toThrow();
  await expect(actions['collective.recovery.reconcile']!({ input }, undefined, context('reconcile', 'stranger'))).rejects.toThrow();
  const completed = await actions['collective.recovery.reconcile']!({ input }, undefined, context('reconcile')) as typeof listed;
  expect(completed.data.rows).toHaveLength(0); expect(effects).toBe(0);
});
