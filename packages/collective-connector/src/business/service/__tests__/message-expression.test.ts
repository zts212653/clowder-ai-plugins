import { describe, expect, it } from 'vitest';
import { collectiveHumanMessageRequestSchema, collectiveEventEnvelopeSchema } from '../../contracts/index.js';

const attachment = {
  v: 1, attachmentId: 'att_screenshot01', contentRef: 'collective-attachment:screenshot01',
  ownerRevision: 1, blobDigest: `sha256:${'a'.repeat(64)}`,
  ownerReceiptRef: 'content-receipt:screenshot01',
  mediaType: 'image/png', byteLength: 128, fileName: '截图.png',
};
const request = {
  serviceInstanceId: 'svc_service01', collectiveId: 'col_collective01', clientEventId: 'paste-two-remove-one',
  location: { channelId: 'general' }, recipient: { kind: 'channel' }, body: '看看这张图',
};

describe('ordinary Channel expression contract', () => {
  it('accepts a stable attachment reference and attachment-only messages, keeping legacy text valid', () => {
    expect(collectiveHumanMessageRequestSchema.parse(request)).toEqual(request);
    expect(collectiveHumanMessageRequestSchema.parse({ ...request, attachments: [attachment] }).attachments)
      .toEqual([attachment]);
    expect(collectiveHumanMessageRequestSchema.parse({ ...request, body: '', attachments: [attachment] }).body).toBe('');
    expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, body: '' }).success).toBe(false);
  });

  it('round-trips the same content in public history without accepting ephemeral bytes or URLs', () => {
    const event = {
      ...request, eventId: 'evt_message01', sequence: 1,
      target: { kind: 'channel', channelId: 'general' },
      actor: { kind: 'human', humanId: 'human_member01', displayName: 'Member' },
      acceptedAt: '2026-10-25T07:00:00.000Z', attachments: [attachment],
    };
    expect(collectiveEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, attachments: [{ ...attachment, url: 'blob:private' }] }).success).toBe(false);
    expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, attachments: [{ ...attachment, bytesBase64: 'aGVsbG8=' }] }).success).toBe(false);
  });
});
