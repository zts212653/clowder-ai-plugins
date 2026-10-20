import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ConnectorPersistence } from '../persistence.js';
import { CollectiveServiceClient, ConnectorTransportError } from '../service-client.js';
import { LocalOperationRecovery } from '../local-operation-recovery.js';
import { hostRouteConfigSchema } from '../host-route-state.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(effect: 'unknown' | 'not_started' = 'not_started') {
  const dir = await mkdtemp(join(tmpdir(), 'collective-recovery-cas-')); dirs.push(dir);
  const persistence = await ConnectorPersistence.open(dir);
  await persistence.transaction(state => {
    state.connections.conn = { serviceUrl: 'http://fixture.localhost:5271', clientBuildId: 'collective-client-v2',
      serviceInstanceId: 'svc', collectiveId: 'col', connectionId: 'conn', endpointId: 'endpoint', authorizedHumanId: 'human',
      endpointLabel: 'Fixture', endpointCredential: 'fixture-secret-not-projected', authorityStatus: 'connected', liveStatus: 'online',
      lastAckedSequence: 0, outbox: [], inbox: [], createdAt: new Date().toISOString() };
    state.hostRoutes.conn = hostRouteConfigSchema.parse({ connectionId: 'conn', localOwnerUserId: 'owner', defaultIngressThreadId: 'thread',
      humanNotificationThreadId: 'thread', agentRoutes: {}, revision: 1, updatedAt: new Date().toISOString() });
  });
  const service = new CollectiveServiceClient(async () => { throw new Error('No network'); });
  Object.defineProperty(service, 'usesLocalTransport', { value: () => true });
  const driver = new LocalOperationRecovery(persistence, service, Date.now);
  await expect(driver.run('conn', 'outbox', 'same-event', { body: 'private-body' }, async () => {
    throw new ConnectorTransportError('Unknown response', 504, 'BROWSER_SERVICE_TIMEOUT', { code: 'BROWSER_SERVICE_TIMEOUT', effect, automaticRetry: false });
  }, () => {})).rejects.toBeInstanceOf(ConnectorTransportError);
  return { dir, persistence, driver, attempt: persistence.snapshot().connections.conn.localAttempts![0]!,
    owner: { userId: 'owner', async assertCurrent() {} } };
}
it('explicit not_started resume is single-entry and the same revision cannot resume twice', async () => {
  const f = await fixture(); let writes = 0;
  const resume = () => f.driver.resume('conn', f.attempt.operationId, f.attempt.revision, f.owner, 'outbox', 'same-event',
    { body: 'private-body' }, async () => { writes++; }, () => {});
  const outcomes = await Promise.allSettled([resume(), resume()]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(writes).toBe(1);
  expect(f.persistence.snapshot().connections.conn.localAttempts?.[0]).toMatchObject({ status: 'settled', generation: 2, proof: 'confirmed' });
});
it('owner, stale revision and changed payload cannot make an unknown or not_started hold eligible', async () => {
  const f = await fixture(); let entered = 0;
  for (const [owner, revision, payload] of [[{ userId: 'stranger', async assertCurrent() {} }, f.attempt.revision, 'private-body'],
    [f.owner, 999, 'private-body'], [f.owner, f.attempt.revision, 'changed-body']] as const) {
    await expect(f.driver.resume('conn', f.attempt.operationId, revision, owner, 'outbox', 'same-event', { body: payload }, async () => { entered++; }, () => {})).rejects.toThrow();
  }
  expect(entered).toBe(0);
  const unknown = await fixture('unknown');
  await expect(unknown.driver.resume('conn', unknown.attempt.operationId, unknown.attempt.revision, unknown.owner, 'outbox', 'same-event',
    { body: 'private-body' }, async () => { entered++; }, () => {})).rejects.toThrow(); expect(entered).toBe(0);
});
it('reconciliation records unresolved proof, confirms full effect without reentry, and fences expired callers', async () => {
  const f = await fixture('unknown'); let settled = 0;
  const unresolved = await f.driver.reconcile('conn', f.attempt.operationId, f.attempt.revision, f.owner,
    async () => ({ outcome: 'unresolved' }), () => { settled++; });
  expect(unresolved.status).toBe('held'); expect(settled).toBe(0);
  let live = true;
  const expired = { userId: 'owner', async assertCurrent() { if (!live) throw new Error('expired'); } };
  await expect(f.driver.reconcile('conn', f.attempt.operationId, unresolved.revision, expired, async () => {
    live = false; return { outcome: 'confirmed', value: undefined };
  }, () => { settled++; })).rejects.toThrow('expired');
  expect(settled).toBe(0);
  await f.driver.reconcile('conn', f.attempt.operationId, unresolved.revision, f.owner, async () => ({ outcome: 'confirmed', value: undefined }), () => { settled++; });
  expect(settled).toBe(1);
});
it('verified whole-operation replay proof permits one explicit resume while unknown effect remains accurately recorded', async () => {
  const f = await fixture('unknown');
  const safe = await f.driver.reconcile('conn', f.attempt.operationId, f.attempt.revision, f.owner, async () => ({ outcome: 'replay_safe' }), () => {});
  expect(safe).toMatchObject({ status: 'held', effect: 'unknown', proof: 'replay_safe' });
  let entered = 0;
  await f.driver.resume('conn', safe.operationId, safe.revision, f.owner, 'outbox', 'same-event', { body: 'private-body' }, async () => { entered++; }, () => {});
  expect(entered).toBe(1);
});
it('v2 remote state migrates explicitly; corrupt/modified local state is never recreated or overwritten', async () => {
  const f = await fixture(); const bytes = await readFile(f.persistence.filePath);
  await writeFile(f.persistence.filePath, '{broken');
  await expect(ConnectorPersistence.open(f.dir)).rejects.toThrow();
  await expect(f.persistence.transaction(() => {})).rejects.toMatchObject({ code: 'COLLECTIVE_STATE_STALE' });
  expect(await readFile(f.persistence.filePath, 'utf8')).toBe('{broken');
  const raw = JSON.parse(bytes.toString()); raw.schemaVersion = 2; delete raw.connections.conn.localAttempts;
  await writeFile(f.persistence.filePath, JSON.stringify(raw)); const migrated = await ConnectorPersistence.open(f.dir);
  expect(migrated.snapshot()).toMatchObject({ schemaVersion: 3 }); expect(migrated.snapshot().connections.conn.localAttempts).toBeUndefined();
});
it('persisted recovery IDs, proof states and attempt cardinality fail closed before any recovery effect', async () => {
  const f = await fixture(); const original = JSON.parse(await readFile(f.persistence.filePath, 'utf8'));
  const corruptions = [
    (value: typeof original) => { value.connections.conn.localAttempts[0].operationId = 'f'.repeat(64); },
    (value: typeof original) => { value.connections.conn.localAttempts[0].proof = 'confirmed'; },
    (value: typeof original) => { value.connections.conn.localAttempts[0].revision = Number.MAX_SAFE_INTEGER + 1; },
    (value: typeof original) => { value.connections.conn.localAttempts.push(structuredClone(value.connections.conn.localAttempts[0])); },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(original); corrupt(value); const bytes = JSON.stringify(value);
    await writeFile(f.persistence.filePath, bytes);
    await expect(ConnectorPersistence.open(f.dir)).rejects.toThrow();
    expect(await readFile(f.persistence.filePath, 'utf8')).toBe(bytes);
  }
});
