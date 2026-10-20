import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { transferFixture } from './artifact-transfer.fixture.js';

async function pageFixture() {
  const f = await transferFixture();
  await f.prepare();
  const bytes = Buffer.from('owner-only-page'.padEnd(1000, '.'));
  const page = {
    transferId: f.input.transferId,
    index: 0,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    base64: bytes.toString('base64'),
  };
  const request = { ...f.targetInput, index: 0 };
  const poll = { ...f.coordinates, connectionId: f.connection.connectionId };
  const next = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await f.post('/api/artifacts/custody/pages/poll', f.connection.endpointCredential, poll);
      expect(result.status).toBe(200);
      if (result.value.operations[0]) return result.value.operations[0];
    }
    throw new Error('Expected a real pending custody page');
  };
  return { ...f, page, request, poll, next };
}

it('relays one bounded custody page to the exact target and never persists page bytes', async () => {
  const f = await pageFixture();
  expect(
    (
      await f.post('/api/artifacts/custody/pages/request', f.connection.endpointCredential, {
        ...f.sourceInput,
        index: 0,
      })
    ).status,
  ).toBe(409);
  const waiting = f.post('/api/artifacts/custody/pages/request', f.target.endpointCredential, f.request);
  const operation = await f.next();
  expect(operation.transfer.prepared).toEqual(f.proof);
  expect(operation).not.toHaveProperty('credential');
  const response = { ...f.poll, relayRef: operation.relayRef, status: 'ok', page: f.page };
  expect(
    (
      await f.post('/api/artifacts/custody/pages/respond', f.target.endpointCredential, {
        ...response,
        connectionId: f.target.connectionId,
      })
    ).status,
  ).toBe(403);
  expect((await f.post('/api/artifacts/custody/pages/respond', f.connection.endpointCredential, response)).status).toBe(
    200,
  );
  expect(await waiting).toEqual({ status: 200, value: { page: f.page } });
  const persisted = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  expect(persisted).not.toContain(f.page.base64);
  expect(persisted).not.toContain(operation.relayRef);
});

it('rechecks target access before page disclosure and drops the in-flight payload on shutdown', async () => {
  for (const outcome of ['revoke', 'shutdown']) {
    const f = await pageFixture();
    const waiting = f.post('/api/artifacts/custody/pages/request', f.target.endpointCredential, f.request);
    const operation = await f.next();
    if (outcome === 'revoke') {
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        humanId: f.member.human.humanId,
        expectedAccessRevision: 1,
        access: 'revoked',
        requestId: 'revoke-page-target',
      });
      expect(
        (
          await f.post('/api/artifacts/custody/pages/respond', f.connection.endpointCredential, {
            ...f.poll,
            relayRef: operation.relayRef,
            status: 'ok',
            page: f.page,
          })
        ).status,
      ).toBe(403);
      expect((await waiting).status).toBe(403);
    } else {
      f.store.stopArtifactOwnerRelay();
      expect((await waiting).status).toBe(503);
      f.store.startArtifactOwnerRelay();
      const retry = f.post('/api/artifacts/custody/pages/request', f.target.endpointCredential, f.request);
      const next = await f.next();
      expect(next.relayRef).not.toBe(operation.relayRef);
      expect(
        (
          await f.post('/api/artifacts/custody/pages/respond', f.connection.endpointCredential, {
            ...f.poll,
            relayRef: operation.relayRef,
            status: 'ok',
            page: f.page,
          })
        ).status,
      ).toBe(403);
      await f.post('/api/artifacts/custody/pages/respond', f.connection.endpointCredential, {
        ...f.poll,
        relayRef: next.relayRef,
        status: 'ok',
        page: f.page,
      });
      expect((await retry).status).toBe(200);
    }
  }
});

it('expires a page RPC after its bounded lifetime and rejects changed bytes without disclosing them', async () => {
  const f = await pageFixture();
  vi.useFakeTimers();
  try {
    const pending = f.store.requestArtifactCustodyPage(f.target.endpointCredential, f.request);
    expect(f.store.requestArtifactCustodyPage(f.target.endpointCredential, f.request)).toBe(pending);
    const expired = expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_OWNER_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(8001);
    await expired;
    expect(f.store.pollArtifactCustodyPages(f.connection.endpointCredential, f.poll)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
  const waiting = f.post('/api/artifacts/custody/pages/request', f.target.endpointCredential, f.request);
  const operation = await f.next();
  const bad = await f.post('/api/artifacts/custody/pages/respond', f.connection.endpointCredential, {
    ...f.poll,
    relayRef: operation.relayRef,
    status: 'ok',
    page: { ...f.page, digest: `sha256:${'f'.repeat(64)}` },
  });
  expect(bad.status).toBe(400);
  const result = await waiting;
  expect(result.status).toBe(400);
  expect(result.value).not.toHaveProperty('page');
});
