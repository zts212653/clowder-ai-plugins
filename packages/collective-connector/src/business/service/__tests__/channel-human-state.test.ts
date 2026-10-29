import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { CollectiveServiceStore } from '../store.js';

it('persists one draft per Human/channel, rejects concurrent overwrites and ignores an old send ACK', async () => {
  const f = await artifactFixture();
  await f.store.createChannel(f.owner.sessionToken, {
    collectiveId: f.coordinates.collectiveId,
    name: 'other',
    clientOperationId: 'draft-other-channel',
  });
  const content = { body: '我的私人草稿', recipient: { kind: 'channel' }, recipientLabel: '' };
  const input = { ...f.coordinates, channelId: 'general', expectedRevision: 0, clientOperationId: 'draft-A-1', content };
  const saved = await f.post('/api/channel-state/draft', f.owner.sessionToken, input);
  expect(saved.status).toBe(200);
  expect(saved.value).toMatchObject({ status: 'stored', draft: { revision: 1, content } });
  const reusedOperation = await f.post('/api/channel-state/draft', f.owner.sessionToken,
    { ...input, content: { ...content, body: '同一个操作编号换了内容' } });
  expect(reusedOperation.status).toBe(409);
  const conflict = await f.post('/api/channel-state/draft', f.owner.sessionToken,
    { ...input, clientOperationId: 'window-B', content: { ...content, body: '另一窗口' } });
  expect(conflict.value).toMatchObject({ status: 'conflict', draft: { revision: 1, content } });
  const current = await f.post('/api/channel-state/draft', f.owner.sessionToken,
    { ...input, expectedRevision: 1, clientOperationId: 'new-draft', content: { ...content, body: '后来新写的' } });
  expect(current.value.draft.revision).toBe(2);
  await f.store.postHumanMessage(f.owner.sessionToken, { ...f.coordinates, clientEventId: 'old-send',
    location: { channelId: 'general' }, recipient: { kind: 'channel' }, body: content.body,
    draftReceipt: { revision: 1 } });
  const reopened = (await CollectiveServiceStore.open({ dataDirectory: f.directory })).store;
  expect(reopened.readHumanChannelState(f.owner.sessionToken, { ...f.coordinates, channelId: 'general' }).draft)
    .toMatchObject({ revision: 2, content: { body: '后来新写的' } });
  expect(reopened.readHumanChannelState(f.member.sessionToken, { ...f.coordinates, channelId: 'general' }).draft.revision).toBe(0);
  expect(reopened.readHumanChannelState(f.owner.sessionToken, { ...f.coordinates, channelId: 'other' }).draft.revision).toBe(0);
});

it('consumes only the exact sent draft and advances read position monotonically from a same-channel message', async () => {
  const f = await artifactFixture();
  await f.store.createChannel(f.owner.sessionToken, {
    collectiveId: f.coordinates.collectiveId,
    name: 'other',
    clientOperationId: 'read-other-channel',
  });
  const coordinates = { ...f.coordinates, channelId: 'general' };
  const content = { body: '发送后草稿清空', recipient: { kind: 'channel' }, recipientLabel: '' };
  const saved = await f.post('/api/channel-state/draft', f.member.sessionToken,
    { ...coordinates, expectedRevision: 0, clientOperationId: 'member-draft-1', content });
  expect(saved.status).toBe(200);
  const sent = await f.store.postHumanMessage(f.member.sessionToken, { ...f.coordinates, clientEventId: 'send-current'.padEnd(200, 'x'),
    location: { channelId: 'general' }, recipient: { kind: 'channel' }, body: content.body,
    draftReceipt: { revision: 1 } });
  expect(f.store.readHumanChannelState(f.member.sessionToken, coordinates).draft).toMatchObject({ revision: 2, content: { body: '' } });
  const read = await f.post('/api/channel-state/read', f.member.sessionToken, { ...coordinates, eventId: sent.eventId });
  expect(read.value.read).toMatchObject({ eventId: sent.eventId, sequence: sent.sequence });
  const older = await f.post('/api/channel-state/read', f.member.sessionToken, { ...coordinates, eventId: f.source.eventId });
  expect(older.value.read.sequence).toBe(sent.sequence);
  const wrong = await f.post('/api/channel-state/read', f.member.sessionToken, { ...coordinates, channelId: 'other', eventId: sent.eventId });
  expect(wrong.status).toBe(403);
  expect(f.store.readHumanChannelState(f.owner.sessionToken, coordinates).read.sequence).toBe(0);
});
