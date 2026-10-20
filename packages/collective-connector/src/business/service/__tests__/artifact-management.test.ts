import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { transferFixture } from './artifact-transfer.fixture.js';
import { collectiveArtifactManagementSchema } from '../../contracts/index.js';

it('reads current per-Artifact management authority only for an authenticated manager and pages the real member policies', async () => {
  const f = await artifactFixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifact = registered.value.artifact;
  const input = { ...f.coordinates, artifactId: artifact.artifactId, limit: 1 };
  const first = await f.post('/api/artifacts/management/read', f.owner.sessionToken, input);
  expect(first.status).toBe(200);
  const management = first.value.management;
  expect(management).toMatchObject({
    artifactId: artifact.artifactId,
    canManageAccess: true,
    canManageCustody: true,
    custodyRevision: 1,
    custodianHumanId: f.owner.human.humanId,
    total: 2,
    nextOffset: 1,
  });
  expect(management.members).toHaveLength(1);
  const next = await f.post('/api/artifacts/management/read', f.owner.sessionToken, {
    ...input,
    offset: 1,
    snapshot: management.snapshot,
  });
  expect(next.status).toBe(200);
  expect(next.value.management.members).toHaveLength(1);
  const policies = [...management.members, ...next.value.management.members];
  expect(policies.find((member) => member.humanId === f.member.human.humanId)).toMatchObject({
    access: 'read',
    accessRevision: 1,
    canReceiveCustody: false,
  });
  expect((await f.post('/api/artifacts/management/read', f.member.sessionToken, input)).status).toBe(403);
  expect((await f.post('/api/artifacts/management/read', f.connection.endpointCredential, input)).status).toBe(401);
  expect(
    (
      await f.post('/api/artifacts/management/read', f.owner.sessionToken, {
        ...input,
        humanId: f.member.human.humanId,
      })
    ).status,
  ).toBe(400);
  expect(JSON.stringify(first.value)).not.toMatch(/endpointId|credential|ownerScopeRef|preparedRef/);
  expect(management.custodianCafe).toEqual({
    connectionId: f.connection.connectionId,
    endpointLabel: 'Editable label',
  });
  expect(artifact).toMatchObject({ canManageAccess: true, canManageCustody: true });
  const reader = f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0];
  expect(reader).toMatchObject({ canManageAccess: false, canManageCustody: false });
});

it('invalidates a management page after a policy change and lets an existing manager restore access without granting content read', async () => {
  const f = await artifactFixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const input = { ...f.coordinates, artifactId: registered.value.artifact.artifactId, limit: 1 };
  const firstResponse = await f.post('/api/artifacts/management/read', f.owner.sessionToken, input);
  expect(firstResponse.status).toBe(200);
  const first = firstResponse.value.management;
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: input.artifactId,
    humanId: f.owner.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'explicit-self-revoke',
  });
  expect(
    (
      await f.post('/api/artifacts/management/read', f.owner.sessionToken, {
        ...input,
        offset: 1,
        snapshot: first.snapshot,
      })
    ).status,
  ).toBe(409);
  const current = await f.post('/api/artifacts/management/read', f.owner.sessionToken, input);
  expect(current.status).toBe(200);
  expect(current.value.management.snapshot).not.toBe(first.snapshot);
  expect(
    (
      await f.post('/api/artifacts/constraints', f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: input.artifactId,
        sourceEventId: f.source.eventId,
        action: 'read',
      })
    ).status,
  ).toBe(403);
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: input.artifactId,
    humanId: f.owner.human.humanId,
    expectedAccessRevision: 2,
    access: 'read',
    requestId: 'manager-restores-explicit-read',
  });
  expect(
    (
      await f.post('/api/artifacts/constraints', f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: input.artifactId,
        sourceEventId: f.source.eventId,
        action: 'read',
      })
    ).status,
  ).toBe(201);
});

it('projects actual handoff phases and current manager roles while withholding other members policies from the new custodian', async () => {
  const f = await transferFixture();
  const input = { ...f.coordinates, artifactId: f.artifact.artifactId };
  const read = (token: string) => f.post('/api/artifacts/management/read', token, input);
  const offered = await read(f.owner.sessionToken);
  expect(offered.status).toBe(200);
  expect(offered.value.management.transfer).toMatchObject({
    transferId: f.input.transferId,
    state: 'offered',
    targetHumanId: f.member.human.humanId,
    targetCafe: { connectionId: f.target.connectionId, endpointLabel: 'Transfer target' },
  });
  expect(
    collectiveArtifactManagementSchema.parse(offered.value.management).members.find((member) => member.humanId === f.member.human.humanId)?.canReceiveCustody,
  ).toBe(true);
  await f.prepare();
  expect((await read(f.owner.sessionToken)).value.management.transfer.state).toBe('source_prepared');
  await f.attest();
  await f.store.acceptArtifactCustody(f.target.endpointCredential, f.accept);
  const committed = await read(f.member.sessionToken);
  expect(committed.status).toBe(200);
  expect(committed.value.management).toMatchObject({
    canManageAccess: false,
    canManageCustody: true,
    custodyRevision: 2,
    custodianHumanId: f.member.human.humanId,
    transfer: { state: 'committed', targetFinalized: false },
  });
  expect(
    collectiveArtifactManagementSchema.parse(committed.value.management).members.every(
      (member) => member.access === undefined && member.accessRevision === undefined,
    ),
  ).toBe(true);
});
