import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceStore } from '../store.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];
const fingerprint = `SHA256:${'A'.repeat(43)}`;
const provider: HumanAuthProvider = {
  id: 'github',
  readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
  authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-invite-access-'));
  directories.push(directory);
  const opened = await CollectiveServiceStore.open({ dataDirectory: directory, humanAuthProvider: provider });
  if (!opened.bootstrapSecret) throw new Error('Missing bootstrap secret');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Owner' });
  const bind = await opened.store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken: owner.sessionToken });
  const bound = await opened.store.completeHumanAuth({ provider: 'github', state: bind.state, code: 'owner' });
  await opened.store.exchangeHumanAuthCompletion(bound.completionToken);
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Example' });
  const invitation = await opened.store.createInvite({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId });
  const begin = await opened.store.beginHumanAuth({ provider: 'github', intent: { kind: 'accept_invite', inviteToken: invitation.inviteToken } });
  const complete = await opened.store.completeHumanAuth({ provider: 'github', state: begin.state, code: 'friend' });
  const member = await opened.store.exchangeHumanAuthCompletion(complete.completionToken);
  const server = await startCollectiveServer({ store: opened.store, port: 0 });
  servers.push(server);
  const get = (token?: string, id = collective.collectiveId) => fetch(`${server.url}/api/invites/access-profile?collectiveId=${encodeURIComponent(id)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { ...opened, owner, collective, member, server, get };
}

it('returns the configured SSH connection details only to an authenticated steward', async () => {
  vi.stubEnv('COLLECTIVE_INVITE_SSH_HOST', 'ssh.example.test');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_PORT', '2222');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_FINGERPRINT', fingerprint);
  vi.stubEnv('COLLECTIVE_INVITE_CAFE_SOURCE_REVISION', 'a'.repeat(40));
  vi.stubEnv('COLLECTIVE_INVITE_CAFE_PUBLIC_REVISION', 'b'.repeat(40));
  const f = await fixture();
  const anonymous = await f.get();
  expect(anonymous.status).toBe(401);
  expect(await anonymous.text()).not.toContain('ssh.example.test');
  const member = await f.get(f.member.sessionToken);
  expect(member.status).toBe(403);
  expect(await member.text()).not.toContain('ssh.example.test');
  const unknown = await f.get(f.owner.sessionToken, 'col_00000000');
  expect(unknown.status).toBe(404);
  expect(await unknown.text()).not.toContain('ssh.example.test');
  const response = await f.get(f.owner.sessionToken);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({
    status: 'ready', serviceInstanceId: f.store.serviceInstanceId, collectiveId: f.collective.collectiveId,
    sshHost: 'ssh.example.test', sshPort: 2222, sshHostFingerprint: fingerprint,
    serviceHost: '127.0.0.1', servicePort: f.server.port,
    cafeSourceRevision: 'a'.repeat(40), cafePublicRevision: 'b'.repeat(40),
  });
});

it('reports an unconfigured profile instead of guessing connection details', async () => {
  vi.stubEnv('COLLECTIVE_INVITE_SSH_HOST', '');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_PORT', '');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_FINGERPRINT', '');
  const f = await fixture();
  expect(await (await f.get(f.owner.sessionToken)).json()).toEqual({
    status: 'unconfigured', serviceInstanceId: f.store.serviceInstanceId, collectiveId: f.collective.collectiveId,
  });
});

it.each([
  { host: 'ssh.example.test\nmalicious', port: '22', fingerprint },
  { host: '-oProxyCommand=bad', port: '22', fingerprint },
  { host: '0.0.0.0', port: '22', fingerprint },
  { host: '::1', port: '22', fingerprint },
  { host: 'ssh.example.test', port: '22;bad', fingerprint },
  { host: 'ssh.example.test', port: '22', fingerprint: 'SHA256:not-a-fingerprint' },
])('does not emit a malformed or incomplete profile', async (config) => {
  vi.stubEnv('COLLECTIVE_INVITE_SSH_HOST', config.host);
  vi.stubEnv('COLLECTIVE_INVITE_SSH_PORT', config.port);
  vi.stubEnv('COLLECTIVE_INVITE_SSH_FINGERPRINT', config.fingerprint);
  const f = await fixture();
  const body = await (await f.get(f.owner.sessionToken)).json();
  expect(body).toEqual({ status: 'unconfigured', serviceInstanceId: f.store.serviceInstanceId, collectiveId: f.collective.collectiveId });
});

it('rejects an invalid configured Café revision instead of placing arbitrary text into the invitation', async () => {
  vi.stubEnv('COLLECTIVE_INVITE_SSH_HOST', 'ssh.example.test');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_PORT', '22');
  vi.stubEnv('COLLECTIVE_INVITE_SSH_FINGERPRINT', fingerprint);
  vi.stubEnv('COLLECTIVE_INVITE_CAFE_SOURCE_REVISION', '$(not-a-revision)');
  const f = await fixture();
  expect(await (await f.get(f.owner.sessionToken)).json()).toEqual({
    status: 'unconfigured', serviceInstanceId: f.store.serviceInstanceId, collectiveId: f.collective.collectiveId,
  });
});
