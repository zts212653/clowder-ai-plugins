import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';
import {
  COLLECTIVE_CHANNEL_CREATE_LIMIT,
  collectiveChannelListSchema,
} from '../../contracts/index.js';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceStore } from '../store.js';

const servers: RunningCollectiveServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it('persists steward-created public channels and makes retries, duplicates, and authority explicit', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-public-channel-'));
  directories.push(dataDirectory);
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: authProvider(),
    now: () => Date.parse('2026-10-28T15:00:00.000Z'),
  });
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret ?? '', displayName: 'Landy' });
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: '猫咖共创组' });
  await bindOwner(opened.store, owner.sessionToken);
  const memberToken = await joinMember(opened.store, owner.sessionToken, collective.collectiveId);
  const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
  servers.push(server);

  const initial = await get(server.url, `/api/channels?collectiveId=${collective.collectiveId}`, owner.sessionToken);
  expect(initial).toMatchObject({
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    channels: [{ channelId: 'general', visibility: 'public', createdBy: { displayName: 'Landy' } }],
  });

  const input = { collectiveId: collective.collectiveId, name: '发布节奏', clientOperationId: 'create-release-rhythm' };
  const created = await post(server.url, '/api/channels', input, owner.sessionToken);
  expect(created).toMatchObject({
    status: 'created',
    channel: { channelId: '发布节奏', visibility: 'public', createdBy: { displayName: 'Landy' } },
  });
  await expect(post(server.url, '/api/channels', input, owner.sessionToken)).resolves.toMatchObject({
    status: 'replayed',
    channel: { channelId: '发布节奏' },
  });
  await expect(
    post(server.url, '/api/channels', { ...input, name: '另一个名字' }, owner.sessionToken),
  ).rejects.toMatchObject({ status: 409, code: 'CHANNEL_OPERATION_CONFLICT' });
  await expect(
    post(
      server.url,
      '/api/channels',
      { ...input, name: '  发布节奏  ', clientOperationId: 'create-duplicate-name' },
      owner.sessionToken,
    ),
  ).resolves.toMatchObject({ status: 'existing', channel: { channelId: '发布节奏' } });
  await expect(post(server.url, '/api/channels', input, memberToken)).rejects.toMatchObject({
    status: 403,
    code: 'FORBIDDEN',
  });
  await expect(
    get(server.url, `/api/channels?collectiveId=${collective.collectiveId}`, memberToken),
  ).resolves.toMatchObject({ channels: [{ channelId: 'general' }, { channelId: '发布节奏' }] });
  await expect(
    opened.store.postHumanMessage(memberToken, {
      serviceInstanceId: opened.store.serviceInstanceId,
      collectiveId: collective.collectiveId,
      clientEventId: 'member-posts-created-channel',
      target: { kind: 'channel', channelId: '发布节奏' },
      body: '普通成员也能在公开频道发言。',
    }),
  ).resolves.toMatchObject({ body: '普通成员也能在公开频道发言。', location: { channelId: '发布节奏' } });
  for (const [index, channelId] of ['GENERAL', 'Ｇｅｎｅｒａｌ'].entries()) {
    await expect(
      opened.store.postHumanMessage(memberToken, {
        serviceInstanceId: opened.store.serviceInstanceId,
        collectiveId: collective.collectiveId,
        clientEventId: `member-channel-alias-${index}`,
        target: { kind: 'channel', channelId },
        body: '近似名称不能成为新的频道坐标。',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CHANNEL_NOT_FOUND' });
  }
  await expect(
    post(
      server.url,
      '/api/channels',
      { ...input, name: 'bad/name', clientOperationId: 'create-invalid-name' },
      owner.sessionToken,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(
      server.url,
      '/api/channels',
      { ...input, name: 'bad\nname', clientOperationId: 'create-control-character-name' },
      owner.sessionToken,
    ),
  ).rejects.toMatchObject({ status: 400 });

  const unknownMessage = await fetch(`${server.url}/api/events/human`, {
    method: 'POST',
    headers: {
      origin: server.url,
      authorization: `Bearer ${owner.sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serviceInstanceId: opened.store.serviceInstanceId,
      collectiveId: collective.collectiveId,
      clientEventId: 'unknown-channel-message',
      target: { kind: 'channel', channelId: 'not-created' },
      body: 'This must not invent a channel.',
    }),
  });
  expect(unknownMessage.status).toBe(404);
  await expect(unknownMessage.json()).resolves.toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });

  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const reopened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: authProvider() });
  expect(reopened.store.listChannels(owner.sessionToken, collective.collectiveId)).toMatchObject([
    { channelId: 'general' },
    { channelId: '发布节奏' },
  ]);
  expect(reopened.store.getMetadata()).toMatchObject({ capabilities: { channels: 1 } });
});

it('backfills general and historical event channels when an alpha.17 state first loads the catalogue', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-channel-migration-'));
  directories.push(dataDirectory);
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: authProvider() });
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret ?? '', displayName: 'Landy' });
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: '旧共同体' });
  await bindOwner(opened.store, owner.sessionToken);
  const event = await opened.store.postHumanMessage(owner.sessionToken, {
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    clientEventId: 'legacy-room-event',
    target: { kind: 'channel', channelId: 'general' },
    body: '旧频道历史不能丢。',
  });
  const statePath = join(dataDirectory, 'collective-service.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    channels?: unknown;
    events: Record<string, Array<Record<string, unknown>>>;
  };
  delete state.channels;
  const historical = state.events[collective.collectiveId]?.[0];
  if (!historical) throw new Error('Expected one historical event');
  historical.target = { kind: 'channel', channelId: '历史讨论' };
  historical.location = { channelId: '历史讨论' };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const reopened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: authProvider() });
  expect(reopened.store.listChannels(owner.sessionToken, collective.collectiveId)).toMatchObject([
    { channelId: 'general' },
    { channelId: '历史讨论', createdBy: { displayName: 'Landy' } },
  ]);
  expect(await reopened.store.listEventsForHuman(owner.sessionToken, collective.collectiveId)).toMatchObject([
    { eventId: event.eventId, body: '旧频道历史不能丢。', location: { channelId: '历史讨论' } },
  ]);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
    channels: Record<string, { channelId: string }>;
  };
  expect(Object.values(persisted.channels).map((channel) => channel.channelId).sort()).toEqual([
    'general',
    '历史讨论',
  ]);
});

it('keeps a complete legacy directory readable beyond the managed creation limit', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-channel-large-migration-'));
  directories.push(dataDirectory);
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: authProvider() });
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret ?? '', displayName: 'Landy' });
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: '旧频道档案' });
  await bindOwner(opened.store, owner.sessionToken);
  await opened.store.postHumanMessage(owner.sessionToken, {
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    clientEventId: 'legacy-seed-event',
    target: { kind: 'channel', channelId: 'general' },
    body: '旧频道历史不能丢。',
  });
  const statePath = join(dataDirectory, 'collective-service.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    channels?: unknown;
    events: Record<string, Array<Record<string, unknown>>>;
    clientEventIndex: Record<string, string>;
  };
  delete state.channels;
  const seed = state.events[collective.collectiveId]?.[0];
  const seedClientEventId = seed?.clientEventId;
  if (!seed || typeof seedClientEventId !== 'string') throw new Error('Expected one indexed historical event');
  const seedIndexKey = Object.keys(state.clientEventIndex).find((key) => key.endsWith(`:${seedClientEventId}`));
  if (!seedIndexKey) throw new Error('Expected the historical event index');
  const indexPrefix = seedIndexKey.slice(0, -seedClientEventId.length);
  const history = Array.from({ length: COLLECTIVE_CHANNEL_CREATE_LIMIT }, (_, index) => {
    const channelId = `legacy-${index}`;
    return {
      ...seed,
      eventId: `evt_legacy${String(index).padStart(5, '0')}`,
      clientEventId: `legacy-event-${index}`,
      sequence: index + 1,
      target: { kind: 'channel', channelId },
      location: { channelId },
    };
  });
  state.events[collective.collectiveId] = history;
  state.clientEventIndex = Object.fromEntries(
    history.map((event) => [`${indexPrefix}${String(event.clientEventId)}`, String(event.eventId)]),
  );
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const reopened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: authProvider() });
  const channels = reopened.store.listChannels(owner.sessionToken, collective.collectiveId);
  expect(channels).toHaveLength(COLLECTIVE_CHANNEL_CREATE_LIMIT + 1);
  expect(channels.filter((channel) => channel.channelId.startsWith('legacy-'))).toHaveLength(
    COLLECTIVE_CHANNEL_CREATE_LIMIT,
  );
  expect(
    collectiveChannelListSchema.safeParse({
      serviceInstanceId: reopened.store.serviceInstanceId,
      collectiveId: collective.collectiveId,
      channels,
    }).success,
  ).toBe(true);
  await expect(
    reopened.store.createChannel(owner.sessionToken, {
      collectiveId: collective.collectiveId,
      name: '超过新建上限',
      clientOperationId: 'create-after-legacy-limit',
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: 'CHANNEL_LIMIT_REACHED' });
});

async function bindOwner(store: CollectiveServiceStore, sessionToken: string) {
  const attempt = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'owner' });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
}

async function joinMember(store: CollectiveServiceStore, ownerToken: string, collectiveId: string) {
  const invite = await store.createInvite({ sessionToken: ownerToken, collectiveId });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'member' });
  return (await store.exchangeHumanAuthCompletion(completion.completionToken)).sessionToken;
}

function authProvider(): HumanAuthProvider {
  return {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
    authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code === 'owner' ? 'Landy' : '吴浪' }),
  };
}

async function get(baseUrl: string, path: string, token: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw { status: response.status, ...(payload.error as Record<string, unknown>) };
  return payload;
}

async function post(baseUrl: string, path: string, body: unknown, token: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw { status: response.status, ...(payload.error as Record<string, unknown>) };
  return payload;
}
