import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceStore } from '../store.js';

const servers: RunningCollectiveServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const provider: HumanAuthProvider = {
  id: 'github',
  readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
  authenticate: async ({ code }) => ({
    providerSubject: code,
    handle: code,
    displayName: code === 'owner' ? 'Landy' : 'Friend',
  }),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-invites-'));
  directories.push(directory);
  let time = 1_788_000_000_000;
  const now = () => time;
  const opened = await CollectiveServiceStore.open({ dataDirectory: directory, humanAuthProvider: provider, now });
  if (!opened.bootstrapSecret) throw new Error('Missing bootstrap secret');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Landy' });
  const bind = await opened.store.beginHumanAuth({
    provider: 'github', intent: { kind: 'bind' }, sessionToken: owner.sessionToken,
  });
  const bound = await opened.store.completeHumanAuth({ provider: 'github', state: bind.state, code: 'owner' });
  await opened.store.exchangeHumanAuthCompletion(bound.completionToken);
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Meow-Club' });
  const server = await startCollectiveServer({ store: opened.store, port: 0 });
  servers.push(server);
  const post = (path: string, body: object, token?: string) => fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      origin: server.url,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    directory, server, store: opened.store, owner, collective, now,
    advance: (milliseconds: number) => { time += milliseconds; },
    post,
  };
}

describe('a Collective invite across the HTTP boundary', () => {
  it('lets a person or cat preview without consuming it, then reflects the real one-time join', async () => {
    const f = await fixture();
    const invitation = await f.store.createInvite({
      sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId,
    });
    const inspect = () => f.post('/api/invites/preview', { inviteToken: invitation.inviteToken });
    const first = await inspect();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(await first.json()).toMatchObject({
      status: 'ready',
      collective: { collectiveId: f.collective.collectiveId, name: 'Meow-Club' },
      inviter: { humanId: f.owner.human.humanId, displayName: 'Landy' },
      serviceInstanceId: f.store.serviceInstanceId,
    });
    expect((await inspect()).status).toBe(200);

    const attempt = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: invitation.inviteToken },
    });
    const completed = await f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'friend' });
    const friend = await f.store.exchangeHumanAuthCompletion(completed.completionToken);
    expect((await f.store.listCollectives(friend.sessionToken))[0]?.collectiveId).toBe(f.collective.collectiveId);
    const usedPreview = await (await inspect()).json();
    expect(usedPreview).toMatchObject({ status: 'used' });
    expect(usedPreview).not.toHaveProperty('memberCount');
    expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).not.toContain(invitation.inviteToken);
  });

  it('keeps revocation steward-only, persistent, and effective even after GitHub verification starts', async () => {
    const f = await fixture();
    const memberInvite = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const memberAttempt = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: memberInvite.inviteToken },
    });
    const memberCompletion = await f.store.completeHumanAuth({ provider: 'github', state: memberAttempt.state, code: 'member' });
    const member = await f.store.exchangeHumanAuthCompletion(memberCompletion.completionToken);
    const invite = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const attempt = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const revokeBody = { collectiveId: f.collective.collectiveId, inviteId: invite.inviteId };
    expect((await f.post('/api/invites/revoke', revokeBody, member.sessionToken)).status).toBe(403);
    expect((await f.post('/api/invites/revoke', revokeBody, f.owner.sessionToken)).status).toBe(200);
    expect(await (await f.post('/api/invites/revoke', revokeBody, f.owner.sessionToken)).json()).toEqual({
      status: 'revoked',
    });
    expect(await (await f.post('/api/invites/preview', { inviteToken: invite.inviteToken })).json()).toMatchObject({
      status: 'revoked',
    });
    await expect(f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'friend' })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
    const reopened = (await CollectiveServiceStore.open({ dataDirectory: f.directory, now: f.now })).store;
    const restartServer = await startCollectiveServer({ store: reopened, port: 0 });
    servers.push(restartServer);
    const afterRestart = await fetch(`${restartServer.url}/api/invites/preview`, {
      method: 'POST', headers: { origin: restartServer.url, 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.inviteToken }),
    });
    expect(await afterRestart.json()).toMatchObject({ status: 'revoked' });
  });

  it('lets an existing member return without consuming an invite intended for a new member', async () => {
    const f = await fixture();
    const invite = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const existingAttempt = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const existingCompletion = await f.store.completeHumanAuth({
      provider: 'github', state: existingAttempt.state, code: 'owner',
    });
    const existing = await f.store.exchangeHumanAuthCompletion(existingCompletion.completionToken);
    expect(existing.human.humanId).toBe(f.owner.human.humanId);
    expect(await (await f.post('/api/invites/preview', { inviteToken: invite.inviteToken })).json()).toMatchObject({
      status: 'ready',
    });
    const newAttempt = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const newCompletion = await f.store.completeHumanAuth({ provider: 'github', state: newAttempt.state, code: 'friend' });
    const friend = await f.store.exchangeHumanAuthCompletion(newCompletion.completionToken);
    expect((await f.store.listCollectives(friend.sessionToken))[0]?.collectiveId).toBe(f.collective.collectiveId);
    expect(await (await f.post('/api/invites/preview', { inviteToken: invite.inviteToken })).json()).toMatchObject({
      status: 'used',
    });
  });

  it('distinguishes expiry while disclosing no target or inviter for an unknown token', async () => {
    const f = await fixture();
    const invite = await f.store.createInvite({
      sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId, ttlMs: 1_000,
    });
    f.advance(1_001);
    const expiredPreview = await (await f.post('/api/invites/preview', { inviteToken: invite.inviteToken })).json();
    expect(expiredPreview).toMatchObject({ status: 'expired' });
    expect(expiredPreview).not.toHaveProperty('memberCount');
    const unknown = await f.post('/api/invites/preview', { inviteToken: 'unknown-invite-secret' });
    expect(await unknown.json()).toEqual({ status: 'invalid' });
    const foreignOrigin = await fetch(`${f.server.url}/api/invites/preview`, {
      method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.inviteToken }),
    });
    expect(foreignOrigin.status).toBe(403);
  });

  it('lets only a steward list invitations for one Collective without returning secrets', async () => {
    const f = await fixture();
    const membershipInvite = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const auth = await f.store.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: membershipInvite.inviteToken },
    });
    const completion = await f.store.completeHumanAuth({ provider: 'github', state: auth.state, code: 'member' });
    const member = await f.store.exchangeHumanAuthCompletion(completion.completionToken);
    const revoked = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    await f.store.revokeInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId, inviteId: revoked.inviteId });
    const ready = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const other = await f.store.createCollective({ sessionToken: f.owner.sessionToken, name: 'Other' });
    const outside = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: other.collectiveId });
    const list = (token?: string, cursor?: string) => {
      const query = new URLSearchParams({ collectiveId: f.collective.collectiveId, limit: '1' });
      if (cursor) query.set('cursor', cursor);
      return fetch(`${f.server.url}/api/invites?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    };
    expect((await list()).status).toBe(401);
    expect((await list(member.sessionToken)).status).toBe(403);
    const invitations = [];
    let cursor: string | undefined;
    do {
      const response = await list(f.owner.sessionToken, cursor);
      expect(response.status).toBe(200);
      const body = await response.json() as { invites: Array<{ inviteId: string; status: string }>; nextCursor?: string };
      expect(body.invites.length).toBeLessThanOrEqual(1);
      invitations.push(...body.invites);
      cursor = body.nextCursor;
    } while (cursor);
    expect(invitations).toHaveLength(3);
    expect(invitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ inviteId: membershipInvite.inviteId, status: 'used' }),
      expect.objectContaining({ inviteId: revoked.inviteId, status: 'revoked' }),
      expect.objectContaining({ inviteId: ready.inviteId, status: 'ready' }),
    ]));
    const text = JSON.stringify(invitations);
    for (const secret of [membershipInvite.inviteToken, revoked.inviteToken, ready.inviteToken, outside.inviteToken]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(outside.inviteId);
    expect(text).not.toContain('tokenDigest');
  });

  it('continues to accept older persisted invitations without inventing an inviter', async () => {
    const f = await fixture();
    const invite = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.collective.collectiveId });
    const file = join(f.directory, 'collective-service.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as { invites: Record<string, Record<string, unknown>> };
    delete state.invites[invite.inviteId]?.createdByHumanId;
    await writeFile(file, `${JSON.stringify(state)}\n`);
    const reopened = (await CollectiveServiceStore.open({ dataDirectory: f.directory, now: f.now, humanAuthProvider: provider })).store;
    const server = await startCollectiveServer({ store: reopened, port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/api/invites/preview`, {
      method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.inviteToken }),
    });
    expect(await response.json()).toMatchObject({ status: 'ready', inviter: null });
    const attempt = await reopened.beginHumanAuth({ provider: 'github', intent: { kind: 'accept_invite', inviteToken: invite.inviteToken } });
    const completion = await reopened.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'friend' });
    const friend = await reopened.exchangeHumanAuthCompletion(completion.completionToken);
    expect((await reopened.listCollectives(friend.sessionToken))[0]?.collectiveId).toBe(f.collective.collectiveId);
  });
});
