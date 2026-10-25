import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';

it('refuses an old composer intent that accidentally carries the next signed-in Human credential', async () => {
  const f = await artifactFixture();
  const body = { ...f.coordinates, channelId: 'general', clientOperationId: 'old-human-intent', expectedRevision: 0,
    content: { body: 'These words belong to A', recipient: { kind: 'channel' }, recipientLabel: '' } };
  const response = await fetch(`${f.server.url}/api/channel-state/draft`, { method: 'POST', headers: {
    authorization: `Bearer ${f.member.sessionToken}`, 'content-type': 'application/json',
    'x-collective-human-id': f.owner.human.humanId,
  }, body: JSON.stringify(body) });
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('HUMAN_CONTEXT_CHANGED');
  expect(f.store.readHumanChannelState(f.member.sessionToken, { ...f.coordinates, channelId: 'general' }).draft.content.body).toBe('');
});

it('keeps private read results bound to the same Human while allowing their actual current expression requests', async () => {
  const f = await artifactFixture();
  const query = new URLSearchParams({ ...f.coordinates, channelId: 'general' });
  const wrong = await fetch(`${f.server.url}/api/channel-state?${query}`, { headers: {
    authorization: `Bearer ${f.member.sessionToken}`, 'x-collective-human-id': f.owner.human.humanId,
  } });
  expect(wrong.status).toBe(409);
  const own = await fetch(`${f.server.url}/api/channel-state?${query}`, { headers: {
    authorization: `Bearer ${f.member.sessionToken}`, 'x-collective-human-id': f.member.human.humanId,
  } });
  expect(own.status).toBe(200);
  expect((await own.json()).draft.humanId).toBe(f.member.human.humanId);
});
