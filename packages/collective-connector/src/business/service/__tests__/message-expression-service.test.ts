import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { CollectiveServiceStore } from '../store.js';

it('persists the same public sourced quote through send retry, draft consumption and restart', async () => {
  const f = await artifactFixture();
  const original = await f.store.postHumanMessage(f.owner.sessionToken, { ...f.coordinates, clientEventId: 'quote-source',
    location: { channelId: 'general' }, recipient: { kind: 'channel' }, body: '这张图可以直接打开。' });
  const quote = { v: 1, id: 'ctx-public-quote', kind: 'quote', text: '可以直接打开',
    source: { kind: 'collective_message', ...f.coordinates, channelId: 'general', eventId: original.eventId } };
  const content = { body: '', recipient: { kind: 'channel' }, recipientLabel: '', contextAttachments: [quote] };
  const saved = await f.store.saveHumanChannelDraft(f.member.sessionToken, { ...f.coordinates, channelId: 'general',
    expectedRevision: 0, clientOperationId: 'quote-draft', content });
  const input = { ...f.coordinates, clientEventId: 'quote-send', location: { channelId: 'general' },
    recipient: { kind: 'channel' }, body: '', contextAttachments: [quote], draftReceipt: { revision: saved.draft.revision } };
  const sent = await f.store.postHumanMessage(f.member.sessionToken, input);
  expect(sent.contextAttachments).toEqual([quote]);
  expect((await f.store.postHumanMessage(f.member.sessionToken, input)).eventId).toBe(sent.eventId);
  await expect(f.store.postHumanMessage(f.member.sessionToken, { ...input, contextAttachments: [{ ...quote, text: 'changed' }] }))
    .rejects.toMatchObject({ code: 'CLIENT_EVENT_CONFLICT' });
  expect(f.store.readHumanChannelState(f.member.sessionToken, { ...f.coordinates, channelId: 'general' }).draft.content.body).toBe('');
  expect(f.store.readHumanChannelState(f.member.sessionToken, { ...f.coordinates, channelId: 'general' }).draft.content.contextAttachments).toBeUndefined();
  const restarted = (await CollectiveServiceStore.open({ dataDirectory: f.directory })).store;
  expect((await restarted.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId))
    .find(event => event.eventId === sent.eventId)?.contextAttachments).toEqual([quote]);
  await expect(fetch(`${f.server.url}/api/events/human?collectiveId=${f.coordinates.collectiveId}`, {
    headers: { authorization: `Bearer ${f.owner.sessionToken}`, 'x-collective-message-content': '1' },
  }).then(response => response.status)).resolves.toBe(409);
});

it('cannot publish an unknown or foreign source as a Channel quote', async () => {
  const f = await artifactFixture();
  const quote = { v: 1, id: 'ctx-public-quote', kind: 'quote', text: 'not public here', source: {
    kind: 'collective_message', ...f.coordinates, channelId: 'general', eventId: 'evt_missing01' } };
  await expect(f.store.postHumanMessage(f.member.sessionToken, { ...f.coordinates, clientEventId: 'forged-quote',
    location: { channelId: 'general' }, recipient: { kind: 'channel' }, body: '', contextAttachments: [quote] }))
    .rejects.toMatchObject({ code: 'QUOTE_SOURCE_UNAVAILABLE' });
});
