// Explicit provider fixture for the private SSH engineering lab; never a deployment or account-registration path.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectiveServiceStore } from '../dist/business/service/store.js';
import { ConfigurableGitHubHumanAuthProvider } from '../dist/business/service/github-human-auth-provider.js';
import { GitHubAppManifestSetup } from '../dist/business/service/github-app-manifest-setup.js';

assert.equal(process.env.F290_SSH_LAB_FIXTURE, '1', 'Only explicit isolated fixture runs may seed provider identities');
const directory = await realpath(process.env.F290_SSH_DATA_DIR);
assert.ok(directory.startsWith(join(await realpath(tmpdir()), 'f290-private-ssh-')), 'Fixture data must live in a new private temporary lab');
const origin = new URL(process.env.F290_SSH_SERVICE_URL).origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
const running = await fetch(origin + '/api/meta', { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
assert.equal(running, false, 'Stop the lab Service before seeding its private state');
const provider = { id: 'github', readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://fixture.invalid/?state=${state}`,
  authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code === 'member-A' ? '隔离成员 A' : '隔离成员 B' }) };
const { store } = await CollectiveServiceStore.open({ dataDirectory: directory, humanAuthProvider: provider,
  humanAuthRedirectUri: origin + '/api/auth/github/callback' });
assert.equal(store.getMetadata().bootstrapNeeded, true, 'Only a fresh unclaimed lab may be seeded');
const url = new URL((await readFile(join(directory, 'owner-bootstrap.url'), 'utf8')).trim());
const owner = await store.consumeBootstrap({ secret: new URLSearchParams(url.hash.slice(1)).get('bootstrap'), displayName: '隔离成员 A' });
const bind = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken: owner.sessionToken });
await store.exchangeHumanAuthCompletion((await store.completeHumanAuth({ provider: 'github', state: bind.state, code: 'member-A' })).completionToken);
const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: 'SSH 私有共同体 · 隔离验证' });
const invitation = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId });
const attempt = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'accept_invite', inviteToken: invitation.inviteToken } });
const member = await store.exchangeHumanAuthCompletion((await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'member-B' })).completionToken);
const github = new ConfigurableGitHubHumanAuthProvider({});
const setup = await GitHubAppManifestSetup.open({ dataDirectory: directory, provider: github,
  fetchImpl: async () => Response.json({ id: 1, client_id: 'isolated-fixture-id', client_secret: 'isolated-fixture-secret' }) });
const begun = await setup.begin({ serviceInstanceId: store.serviceInstanceId, serviceUrl: origin,
  humanAuthCallbackUrl: origin + '/api/auth/github/callback', setupCallbackUrl: origin + '/api/setup/github-app/callback' });
await setup.complete({ state: new URL(begun.registrationUrl).searchParams.get('state'), code: 'isolated-fixture-conversion' });
await writeFile(join(directory, 'isolated-browser-sessions.json'), JSON.stringify({ origin,
  serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId, owner, member }), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ provider: 'explicit fixture', humans: 2, serviceInstanceId: store.serviceInstanceId }));
