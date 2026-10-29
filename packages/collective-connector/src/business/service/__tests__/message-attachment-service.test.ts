import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../../contracts/message-attachment-owner.js';
import { CollectiveServiceStore } from '../store.js';

it('does not publish a forged ordinary attachment or silently discard its content', async () => {
  const f = await artifactFixture();
  const forged = { v: 1, attachmentId: 'att_screenshot01', contentRef: 'collective-attachment:unowned',
    ownerRevision: 1, ownerReceiptRef: 'unowned', blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png', byteLength: 128, fileName: 'private.png' };
  await expect(f.store.postHumanMessage(f.owner.sessionToken, { ...f.coordinates,
    clientEventId: 'forged-attachment', location: { channelId: 'general' }, recipient: { kind: 'channel' },
    body: 'not mine', attachments: [forged] })).rejects.toMatchObject({ statusCode: 403 });
});

it('keeps uploads private, publishes exact references once, survives Service restart and fences revoked readers', async () => {
  const retained = new Map<string, Buffer>();
  const messageAttachmentOwner: CollectiveMessageAttachmentOwnerPort = {
    async retain(input, auth) {
      await auth.reauthorize();
      const contentRef = `collective-attachment:${input.scope.attachmentId}`;
      retained.set(contentRef, Buffer.from(input.bytes));
      return { v: 1, attachmentId: input.scope.attachmentId, contentRef, ownerRevision: 1,
        ownerReceiptRef: `receipt:${input.scope.attachmentId}`, blobDigest: input.blobDigest,
        byteLength: input.bytes.byteLength, mediaType: input.mediaType, fileName: input.fileName };
    },
    async open(input, auth) {
      await auth.reauthorize();
      const bytes = retained.get(input.attachment.contentRef);
      if (!bytes) throw new Error('Missing owner bytes');
      return { attachment: input.attachment, status: 200, body: Readable.from([bytes]) };
    },
  };
  const f = await artifactFixture({ messageAttachmentOwner });
  await f.store.createChannel(f.owner.sessionToken, {
    collectiveId: f.coordinates.collectiveId,
    name: 'other',
    clientOperationId: 'message-attachment-other-channel',
  });
  const bytes = Buffer.from('跨成员读取，刷新后仍在');
  const query = new URLSearchParams({ ...f.coordinates, channelId: 'general', clientUploadId: 'paste-two-remove-one',
    fileName: 'notes.txt', mediaType: 'text/plain', blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  const upload = async () => {
    const response = await fetch(`${f.server.url}/api/message-attachments/upload?${query}`, {
      method: 'POST', headers: { authorization: `Bearer ${f.member.sessionToken}` }, body: bytes,
    });
    expect(response.status).toBe(201);
    return response.json();
  };
  const attachment = await upload();
  expect(await upload()).toEqual(attachment);
  const signal = new AbortController().signal;
  const selection = { ...f.coordinates, attachmentId: attachment.attachmentId };
  await expect(f.store.openMessageAttachment(f.owner.sessionToken, selection, signal)).rejects.toMatchObject({ statusCode: 403 });
  const draft = { ...f.coordinates, clientEventId: 'lost-ack-retry', location: { channelId: 'general' },
    recipient: { kind: 'channel' }, body: '', attachments: [attachment] };
  const sent = await f.store.postHumanMessage(f.member.sessionToken, draft);
  expect(sent.attachments).toEqual([attachment]);
  const legacyRead = await fetch(`${f.server.url}/api/events/human?collectiveId=${f.coordinates.collectiveId}`, {
    headers: { authorization: `Bearer ${f.owner.sessionToken}` },
  });
  expect(legacyRead.status).toBe(409);
  expect((await legacyRead.json()).error.code).toBe('MESSAGE_CONTENT_UPGRADE_REQUIRED');
  expect((await f.store.postHumanMessage(f.member.sessionToken, draft)).eventId).toBe(sent.eventId);
  await expect(f.store.postHumanMessage(f.member.sessionToken, { ...draft, body: 'changed payload' }))
    .rejects.toMatchObject({ code: 'CLIENT_EVENT_CONFLICT' });
  await expect(f.store.postHumanMessage(f.member.sessionToken, { ...draft, clientEventId: 'other-channel', location: { channelId: 'other' } }))
    .rejects.toMatchObject({ statusCode: 403 });
  const reopened = (await CollectiveServiceStore.open({ dataDirectory: f.directory, messageAttachmentOwner })).store;
  expect((await reopened.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId)).filter(event => event.eventId === sent.eventId))
    .toHaveLength(1);
  const read = await reopened.openMessageAttachment(f.owner.sessionToken, { ...selection, sourceEventId: sent.eventId }, signal);
  const chunks = [];
  for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  await reopened.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
  await expect(reopened.openMessageAttachment(f.member.sessionToken, { ...selection, sourceEventId: sent.eventId }, signal)).rejects.toMatchObject({ statusCode: 403 });
});

it('offers an authenticated binary staging route for independent members', async () => {
  const f = await artifactFixture();
  const bytes = Buffer.from('ordinary file');
  const response = await fetch(`${f.server.url}/api/message-attachments/upload?${new URLSearchParams({
    ...f.coordinates, channelId: 'general', clientUploadId: 'independent-paste-01', fileName: 'notes.txt',
    mediaType: 'text/plain', blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  })}`, { method: 'POST', headers: { authorization: `Bearer ${f.member.sessionToken}`,
    'content-type': 'application/octet-stream' }, body: bytes });
  // A configured content custodian is required; absent custody must be explicit, not a missing route.
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('ATTACHMENT_OWNER_UNAVAILABLE');
});
