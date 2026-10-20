import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
export const servers: RunningCollectiveServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

export async function artifactFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-artifact-authority-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const attempt = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const complete = await current.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'second-member',
  });
  const member = await current.store.exchangeHumanAuthCompletion(complete.completionToken);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'shared-guide-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '一起修改这份接入指南。',
  });
  const server = await startCollectiveServer({ store: current.store, port: 0 });
  servers.push(server);
  const post = async (path: string, token: string, body: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const registration = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    contentRef: 'content:shared-markdown-guide',
    title: '插件接入指南',
    mediaType: 'text/markdown',
    sourceEventId: source.eventId,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    receiptRef: 'content-receipt:guide-v1',
    requestId: 'publish-guide-v1',
  };
  return { ...current, directory, member, source, server, post, registration };
}
