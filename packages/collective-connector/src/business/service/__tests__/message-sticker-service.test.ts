import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { MESSAGE_STICKER_CATALOG, messageStickerReference } from '../../contracts/index.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../../contracts/message-attachment-owner.js';
import { artifactFixture } from './artifact.fixture.js';
import { assertMessageContentReader } from '../message-content-compatibility.js';

it('withholds a catalogue response when membership changes while the original Host is reading', async () => {
  const entry = MESSAGE_STICKER_CATALOG[0];
  let finish: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const body = Readable.from([Buffer.alloc(entry.byteLength)]);
  let entered: (() => void) | undefined;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const f = await artifactFixture({ messageAttachmentOwner: {
    async retain() { throw new Error('Unused'); }, async open() { throw new Error('Unused'); },
    async catalogImage() { entered!(); await blocked; return { sticker: messageStickerReference(entry.id), body }; },
  } });
  const pending = f.store.openMessageSticker(f.member.sessionToken, { ...f.coordinates, channelId: 'general', stickerId: entry.id }, new AbortController().signal);
  await reading;
  await f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
  finish!();
  await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  expect(body.destroyed).toBe(true);
});

it('fences a version-one reader before it can silently omit a sticker image', async () => {
  const f = await artifactFixture();
  const entry = MESSAGE_STICKER_CATALOG[0];
  const attachment = { v: 1 as const, attachmentId: 'att_sticker001', contentRef: 'collective-attachment:sticker001',
    ownerRevision: 1 as const, ownerReceiptRef: 'receipt:sticker001', fileName: entry.assetFile, mediaType: 'image/png',
    byteLength: entry.byteLength, blobDigest: entry.blobDigest, sticker: messageStickerReference(entry.id) };
  const event = { ...f.source, attachments: [attachment] };
  expect(() => assertMessageContentReader([event], '1')).toThrow('Update this Client');
  expect(() => assertMessageContentReader([event], '2')).not.toThrow();
  expect(() => assertMessageContentReader([{ ...event, attachments: [{ ...attachment, sticker: undefined }] }], '1')).not.toThrow();
});

it('reads the original Host catalogue only for a fresh current member', async () => {
  const entry = MESSAGE_STICKER_CATALOG[0];
  // Explicit byte-port fixture. Core tests read and hash the actual original PNG.
  const read = vi.fn<NonNullable<CollectiveMessageAttachmentOwnerPort['catalogImage']>>(async (input, auth) => {
    await auth.reauthorize();
    return { sticker: messageStickerReference(input.stickerId), body: Readable.from([Buffer.alloc(entry.byteLength)]) };
  });
  const owner: CollectiveMessageAttachmentOwnerPort = { catalogImage: read,
    async retain() { throw new Error('Unused'); }, async open() { throw new Error('Unused'); } };
  const f = await artifactFixture({ messageAttachmentOwner: owner });
  const query = new URLSearchParams({ ...f.coordinates, channelId: 'general', stickerId: entry.id });
  const response = await fetch(`${f.server.url}/api/message-attachments/catalog?${query}`, { method: 'POST', headers: {
    authorization: `Bearer ${f.member.sessionToken}`, 'x-collective-human-id': f.member.human.humanId,
  } });
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(entry.byteLength);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ humanId: f.member.human.humanId }) }), expect.anything(), expect.anything());
  await f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
  const denied = await fetch(`${f.server.url}/api/message-attachments/catalog?${query}`, { method: 'POST', headers: {
    authorization: `Bearer ${f.member.sessionToken}`,
  } });
  expect(denied.status).toBe(403);
  expect(read).toHaveBeenCalledTimes(1);
});

it('does not allow an arbitrary uploaded file to claim a catalogue sticker identity', async () => {
  const f = await artifactFixture();
  const input = { ...f.coordinates, channelId: 'general', clientUploadId: 'fake-sticker', fileName: 'picture.png',
    mediaType: 'image/png', blobDigest: `sha256:${'0'.repeat(64)}`, stickerId: MESSAGE_STICKER_CATALOG[0].id };
  await expect(f.store.uploadMessageAttachment(f.member.sessionToken, input, Readable.from([Buffer.from('not the catalogue image')]),
    new AbortController().signal)).rejects.toMatchObject({ code: 'STICKER_CONTENT_MISMATCH' });
});
