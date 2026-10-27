import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFileAttachmentOwner } from './file-owner.js';
import { attachmentDigest } from './file-store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const scope = {
  serviceInstanceId: 'svc_original1',
  collectiveId: 'col_original1',
  humanId: 'human_original1',
  channelId: 'general',
  attachmentId: 'att_original1',
};
const authority = {
  async reauthorize() {
    return scope;
  },
};
const signal = new AbortController().signal;
const input = (bytes = Buffer.from('original bytes')) => ({
  scope,
  bytes,
  blobDigest: attachmentDigest(bytes),
  fileName: 'notes.txt',
  mediaType: 'text/plain',
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-byte-owner-'));
  directories.push(directory);
  return { directory, owner: createFileAttachmentOwner(directory) };
}
async function consume(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it('concurrent identical retains converge on one immutable receipt and changed payload cannot replace it', async () => {
  const { directory, owner } = await fixture();
  const copies = await Promise.all(Array.from({ length: 4 }, () => owner.retain(input(), authority, signal)));
  for (const copy of copies) expect(copy).toEqual(copies[0]);
  const attachment = copies[0]!;
  await expect(owner.retain({ ...input(), fileName: 'different.txt' }, authority, signal)).rejects.toThrow(
    'reference conflict',
  );
  await expect(owner.retain(input(Buffer.from('changed bytes')), authority, signal)).rejects.toThrow(
    'reference conflict',
  );
  await expect(owner.retain({ ...input(), blobDigest: `sha256:${'a'.repeat(64)}` }, authority, signal)).rejects.toThrow(
    'digest',
  );
  const reopened = createFileAttachmentOwner(directory);
  const full = await reopened.open({ scope, attachment }, authority, signal);
  expect(await consume(full.body)).toEqual(input().bytes);
  const content = join(directory, attachment.contentRef.split(':')[1]!, 'content');
  expect((await stat(content)).mode & 0o777).toBe(0o600);
  expect(await readFile(content)).toEqual(input().bytes);
});

it('rejects forged scope, receipts and corrupted bytes before returning an authorized stream', async () => {
  const { directory, owner } = await fixture();
  const attachment = await owner.retain(input(), authority, signal);
  const other = { ...scope, channelId: 'private' };
  await expect(
    owner.open(
      { scope: other, attachment },
      {
        async reauthorize() {
          return other;
        },
      },
      signal,
    ),
  ).rejects.toThrow('scope');
  await expect(
    owner.open({ scope, attachment: { ...attachment, ownerReceiptRef: 'forged' } }, authority, signal),
  ).rejects.toThrow('reference conflict');
  const content = join(directory, attachment.contentRef.split(':')[1]!, 'content');
  await writeFile(content, 'tampered bytes');
  await expect(owner.open({ scope, attachment }, authority, signal)).rejects.toThrow('bytes changed');
});

it('revalidates authority during streaming and stops after revocation or cancellation', async () => {
  const { owner } = await fixture();
  const attachment = await owner.retain(input(Buffer.alloc(512 * 1024, 42)), authority, signal);
  let revoked = false;
  const auth = {
    async reauthorize() {
      if (revoked) throw new Error('revoked');
      return scope;
    },
  };
  const opened = await owner.open({ scope, attachment }, auth, signal);
  revoked = true;
  await expect(consume(opened.body)).rejects.toThrow('revoked');
  expect(opened.body.destroyed).toBe(true);
  const abort = new AbortController();
  const abandoned = await owner.open({ scope, attachment }, authority, abort.signal);
  abort.abort();
  expect(abandoned.body.destroyed).toBe(true);
  await expect(owner.retain(input(), authority, abort.signal)).rejects.toThrow();
});
