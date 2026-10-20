import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ConnectorPersistence } from '../persistence.js';
import { ConnectorSynchronization } from '../connector-synchronization.js';
import { CollectiveServiceClient, ConnectorTransportError } from '../service-client.js';
import { hostRouteConfigSchema } from '../host-route-state.js';
import { projectConnection } from '../projection.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(kind: 'outbox' | 'ack' | 'participation' | 'revoke', local = true) {
  const path = await mkdtemp(join(tmpdir(), 'collective-local-recovery-')); directories.push(path);
  const persistence = await ConnectorPersistence.open(path);
  await persistence.transaction(state => {
    state.connections.con_fixture_12345678 = {
      serviceUrl: 'http://fixture.localhost:5271', clientBuildId: 'collective-client-v2',
      serviceInstanceId: 'svc_fixture_1234', collectiveId: 'col_fixture_1234', connectionId: 'con_fixture_12345678',
      endpointId: 'endpoint_fixture', authorizedHumanId: 'human_fixture', endpointLabel: 'Fixture',
      endpointCredential: 'fixture-secret-must-not-be-projected', authorityStatus: kind === 'revoke' ? 'revoking' : 'connected',
      liveStatus: 'online', lastAckedSequence: 0, ...(kind === 'ack' ? { pendingAckSequence: 1 } : {}),
      outbox: kind === 'outbox' ? [{ outboxId: 'outbox', clientEventId: 'fixture-event',
        agent: { agentId: 'cat', displayName: 'Cat', catId: 'cat', sessionRef: 'fixture' },
        target: { kind: 'channel', channelId: 'general' }, body: 'private fixture body', status: 'queued', createdAt: new Date().toISOString() }] : [],
      inbox: [], createdAt: new Date().toISOString(),
    };
    if (kind === 'participation') state.hostRoutes.con_fixture_12345678 = hostRouteConfigSchema.parse({ connectionId: 'con_fixture_12345678',
      localOwnerUserId: 'owner', defaultIngressThreadId: 'thread', humanNotificationThreadId: 'thread',
      agentRoutes: {}, revision: 1, updatedAt: new Date().toISOString() });
  });
  const service = new CollectiveServiceClient(async () => { throw new Error('Network forbidden'); });
  Object.defineProperty(service, 'usesLocalTransport', { value: () => local });
  let entered = 0;
  const error = new ConnectorTransportError('Transport timed out', 504, 'BROWSER_SERVICE_TIMEOUT');
  Object.defineProperties(error, { automaticRetry: { value: false }, effect: { value: 'unknown' } });
  const fail = async () => { entered++; throw error; };
  service.postAgentMessage = fail; service.acknowledge = fail; service.publishParticipation = fail; service.revoke = fail;
  service.poll = async (_url, _credential, input) => ({ ...input, events: [], lastAckedSequence: 0 });
  return { path, persistence, service, entered: () => entered };
}
for (const kind of ['outbox', 'ack', 'participation', 'revoke'] as const) {
  it(`durably holds ${kind} across sync, concurrent callers and restart`, async () => {
    const f = await fixture(kind);
    const sync = new ConnectorSynchronization(f.persistence, f.service, Date.now);
    await Promise.all([sync.sync('con_fixture_12345678'), sync.sync('con_fixture_12345678')]);
    await sync.sync('con_fixture_12345678');
    const disk = await ConnectorPersistence.open(f.path);
    const projection = await new ConnectorSynchronization(disk, f.service, Date.now).sync('con_fixture_12345678');
    expect(f.entered()).toBe(1);
    expect(projection).toMatchObject({ recovery: { held: 1, operations: [{ kind, effect: 'unknown' }] } });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('fixture-secret'); expect(serialized).not.toContain('private fixture body');
    if (kind === 'revoke') expect(disk.snapshot().connections.con_fixture_12345678).toMatchObject({ authorityStatus: 'revoking', endpointCredential: 'fixture-secret-must-not-be-projected' });
  });
}
it('preserves the original remote retry behavior', async () => {
  const f = await fixture('outbox', false);
  const sync = new ConnectorSynchronization(f.persistence, f.service, Date.now);
  await sync.sync('con_fixture_12345678'); await sync.sync('con_fixture_12345678');
  expect(f.entered()).toBe(2);
});

it('retains an entered attempt as unknown after restart and refuses the old writer', async () => {
  const f = await fixture('outbox');
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const paused = new Promise<void>(resolve => { finish = resolve; });
  f.service.postAgentMessage = async () => { entered(); await paused; throw new Error('Late failed result'); };
  const running = new ConnectorSynchronization(f.persistence, f.service, Date.now).sync('con_fixture_12345678');
  // Attach observer before the deliberate stale-instance failure.
  const outcome = running.catch(error => error);
  await started;
  const disk = await ConnectorPersistence.open(f.path);
  expect(disk.snapshot().connections.con_fixture_12345678.localAttempts?.[0]).toMatchObject({ status: 'held', effect: 'unknown', reason: 'LOCAL_ATTEMPT_INTERRUPTED' });
  finish(); expect(await outcome).toMatchObject({ code: 'COLLECTIVE_STATE_STALE' });
  expect((await ConnectorPersistence.open(f.path)).snapshot()).toEqual(disk.snapshot());
});
it('a hold does not prevent independent revoke and a Human-unavailable 401 never proves local revocation', async () => {
  const f = await fixture('outbox'); const sync = new ConnectorSynchronization(f.persistence, f.service, Date.now);
  await sync.sync('con_fixture_12345678');
  let revokes = 0;
  f.service.revoke = async () => { revokes++; throw new ConnectorTransportError('Human authority is revoked', 401, 'CONNECTION_REVOKED'); };
  await Promise.all([sync.revoke('con_fixture_12345678'), sync.revoke('con_fixture_12345678')]); await sync.revoke('con_fixture_12345678');
  expect(revokes).toBe(1);
  expect(f.persistence.snapshot().connections.con_fixture_12345678).toMatchObject({ authorityStatus: 'revoking', endpointCredential: 'fixture-secret-must-not-be-projected' });
  expect((await sync.sync('con_fixture_12345678')).recovery?.held).toBe(2);
});
it('settling an older ACK preserves a newer pending target', async () => {
  const f = await fixture('ack');
  f.service.acknowledge = async () => { await f.persistence.transaction(state => { state.connections.con_fixture_12345678.pendingAckSequence = 2; }); };
  await new ConnectorSynchronization(f.persistence, f.service, Date.now).sync('con_fixture_12345678');
  expect(f.persistence.snapshot().connections.con_fixture_12345678.pendingAckSequence).toBe(2);
});
it('a newer declaration cannot bypass an unresolved predecessor', async () => {
  const f = await fixture('participation'); const sync = new ConnectorSynchronization(f.persistence, f.service, Date.now);
  await sync.sync('con_fixture_12345678'); await f.persistence.transaction(state => { state.hostRoutes.con_fixture_12345678.revision++; });
  await sync.sync('con_fixture_12345678'); expect(f.entered()).toBe(1);
  expect(Object.values(f.persistence.snapshot().connections.con_fixture_12345678.localParticipationIntents ?? {})).toMatchObject([{ revision: 1 }]);
});
it('revoked endpoint history stays visible without offering a replay through deleted authority', async () => {
  const f = await fixture('outbox'); await new ConnectorSynchronization(f.persistence, f.service, Date.now).sync('con_fixture_12345678');
  await f.persistence.transaction(state => {
    const connection = state.connections.con_fixture_12345678;
    connection.authorityStatus = 'revoked'; connection.revocationReason = 'owner_revoked'; delete connection.endpointCredential;
  });
  const projection = projectConnection(f.persistence.snapshot().connections.con_fixture_12345678);
  expect(projection.recovery).toMatchObject({ held: 1, operations: [{ kind: 'outbox', choices: [] }] });
});
