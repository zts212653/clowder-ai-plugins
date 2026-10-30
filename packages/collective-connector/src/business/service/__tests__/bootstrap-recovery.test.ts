import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSecret } from '../persistence.js';
import { escrowBootstrapSecret, readBootstrapSecret, rotateBootstrapSecret } from '../bootstrap-files.js';
import { CollectiveServiceStore } from '../store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-bootstrap-recovery-'));
  directories.push(directory);
  let time = Date.UTC(2026, 9, 26);
  const options = { dataDirectory: directory, now: () => time, bootstrapTtlMs: 1000 };
  const first = await CollectiveServiceStore.open(options);
  const renew = vi.fn(async () => createSecret());
  return { directory, options, first, renew, expire: () => { time += 1001; } };
}

it('local reopen rotates an expired unclaimed bootstrap while retaining the entire Service state', async () => {
  const f = await fixture();
  f.expire();
  await expect(f.first.store.consumeBootstrap({ secret: f.first.bootstrapSecret!, displayName: 'Owner' }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_EXPIRED' });
  const before = JSON.parse(await readFile(join(f.directory, 'collective-service.json'), 'utf8'));
  const reopened = await CollectiveServiceStore.open({ ...f.options, renewExpiredBootstrapSecret: f.renew });
  expect(f.renew).toHaveBeenCalledTimes(1);
  const fresh = await f.renew.mock.results[0]!.value;
  expect(fresh).not.toBe(f.first.bootstrapSecret);
  expect(reopened.bootstrapSecret).toBe(fresh);
  const after = JSON.parse(await readFile(join(f.directory, 'collective-service.json'), 'utf8'));
  expect({ ...after, bootstrap: undefined }).toEqual({ ...before, bootstrap: undefined });
  await expect(reopened.store.consumeBootstrap({ secret: f.first.bootstrapSecret!, displayName: 'Old link' }))
    .rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP' });
  const owner = await reopened.store.consumeBootstrap({ secret: fresh, displayName: 'Owner' });
  expect(owner.human.displayName).toBe('Owner');
});

it('reopening does not extend an existing valid bootstrap', async () => {
  const f = await fixture();
  const before = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  const reopened = await CollectiveServiceStore.open({ ...f.options, renewExpiredBootstrapSecret: f.renew });
  expect(f.renew).not.toHaveBeenCalled();
  expect(reopened.bootstrapSecret).toBeUndefined();
  expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).toBe(before);
});

it('reopening after owner setup never creates another bootstrap or removes owner data', async () => {
  const f = await fixture();
  const owner = await f.first.store.consumeBootstrap({ secret: f.first.bootstrapSecret!, displayName: 'Owner' });
  f.expire();
  const before = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  const reopened = await CollectiveServiceStore.open({ ...f.options, renewExpiredBootstrapSecret: f.renew });
  expect(f.renew).not.toHaveBeenCalled();
  expect(reopened.store.getMetadata().bootstrapNeeded).toBe(false);
  expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).toBe(before);
  expect((await reopened.store.requireSession(owner.sessionToken)).human.humanId).toBe(owner.human.humanId);
});

it('without a trusted local renewal callback an expired credential stays expired', async () => {
  const f = await fixture();
  f.expire();
  const reopened = await CollectiveServiceStore.open(f.options);
  await expect(reopened.store.consumeBootstrap({ secret: f.first.bootstrapSecret!, displayName: 'Owner' }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_EXPIRED' });
});

it('private credential replacement is durable and keeps restrictive permissions', async () => {
  const f = await fixture();
  const path = join(f.directory, 'owner-bootstrap.secret');
  const old = await escrowBootstrapSecret(path);
  const fresh = await rotateBootstrapSecret(path);
  expect(fresh).not.toBe(old);
  expect(await readBootstrapSecret(path)).toBe(fresh);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it.each([
  new Error('Escrow unavailable'),
  Object.assign(new Error('Escrow unavailable'), { code: 'ENOENT' }),
])('credential escrow failure leaves the old state intact and allows a later recovery (%s)', async (error) => {
  const f = await fixture();
  f.expire();
  const before = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  await expect(CollectiveServiceStore.open({
    ...f.options, renewExpiredBootstrapSecret: async () => { throw error; },
  })).rejects.toThrow('Escrow unavailable');
  expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).toBe(before);
  const recovered = await CollectiveServiceStore.open({ ...f.options, renewExpiredBootstrapSecret: f.renew });
  expect(recovered.bootstrapSecret).toBeTruthy();
});

it('owner request expiry after escrow does not commit a credential and the running store can retry', async () => {
  const f = await fixture();
  f.expire();
  const before = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  const path = join(f.directory, 'owner-bootstrap.secret');
  let checks = 0;
  await expect(f.first.store.renewExpiredBootstrap(() => rotateBootstrapSecret(path), 1000, async () => {
    if (++checks === 2) throw new Error('Owner request expired');
  })).rejects.toThrow('Owner request expired');
  expect(checks).toBe(2);
  expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).toBe(before);
  const fresh = await f.first.store.renewExpiredBootstrap(() => rotateBootstrapSecret(path), 1000);
  expect((await f.first.store.consumeBootstrap({ secret: fresh!, displayName: 'Owner' })).human.displayName).toBe('Owner');
});
