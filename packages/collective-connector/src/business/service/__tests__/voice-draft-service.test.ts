import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { CollectiveServiceStore } from '../store.js';

it('persists private voice state for its person/channel and excludes it from the explicitly sent public event', async () => {
  const f = await artifactFixture();
  const coordinates = { ...f.coordinates, channelId: 'general' };
  const voiceDraft = { captureId: 'recording-private-001', state: 'ready', applied: true, transcript: '语音转成的文字' };
  const content = { body: '原文字\n语音转成的文字', recipient: { kind: 'channel' }, recipientLabel: '', voiceDraft };
  const saved = await f.store.saveHumanChannelDraft(f.member.sessionToken, { ...coordinates,
    expectedRevision: 0, clientOperationId: 'voice-draft-first', content });
  expect(saved.status).toBe('stored');
  expect(f.store.readHumanChannelState(f.owner.sessionToken, coordinates).draft.content.voiceDraft).toBeUndefined();
  const reopened = (await CollectiveServiceStore.open({ dataDirectory: f.directory })).store;
  expect(reopened.readHumanChannelState(f.member.sessionToken, coordinates).draft.content).toEqual(content);
  const oldClient = await fetch(`${f.server.url}/api/channel-state?${new URLSearchParams(coordinates)}`, {
    headers: { authorization: `Bearer ${f.member.sessionToken}`, 'x-collective-message-content': '1' },
  });
  expect(oldClient.status).toBe(409);
  const send = { ...f.coordinates, clientEventId: 'voice-send-explicit', location: { channelId: 'general' },
    recipient: { kind: 'channel' }, body: content.body, draftReceipt: { revision: saved.draft.revision } };
  const event = await reopened.postHumanMessage(f.member.sessionToken, send);
  expect(event.body).toBe(content.body);
  expect(event).not.toHaveProperty('voiceDraft');
  expect(event.attachments).toBeUndefined();
  expect(event.workRequest).toBeUndefined();
  expect(reopened.readHumanChannelState(f.member.sessionToken, coordinates).draft.content.voiceDraft).toBeUndefined();
  const newer = { ...content, voiceDraft: { captureId: 'new-recording', state: 'recording', applied: false } };
  const next = await reopened.saveHumanChannelDraft(f.member.sessionToken, { ...coordinates, expectedRevision: saved.draft.revision + 1,
    clientOperationId: 'voice-draft-second', content: newer });
  expect(next.status).toBe('stored');
  expect((await reopened.postHumanMessage(f.member.sessionToken, send)).eventId).toBe(event.eventId);
  expect(reopened.readHumanChannelState(f.member.sessionToken, coordinates).draft.content.voiceDraft).toEqual(newer.voiceDraft);
});
