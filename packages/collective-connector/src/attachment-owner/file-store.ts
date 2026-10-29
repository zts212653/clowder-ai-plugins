import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { syncDirectory } from '../directory-durability.js';
import { collectiveAttachmentScopeSchema, collectiveMessageAttachmentSchema } from '../business/contracts/index.js';

const recordSchema = z
  .object({ scope: collectiveAttachmentScopeSchema, attachment: collectiveMessageAttachmentSchema })
  .strict();
type Record = z.infer<typeof recordSchema>;

export const attachmentDigest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Immutable attachment custody only: no Work identity, publication, membership or session is stored here. */
export class AttachmentFileStore {
  constructor(private readonly directory: string) {}

  private path(record: Record) {
    const key = record.attachment.contentRef.slice('collective-attachment:'.length);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid attachment content reference');
    return join(this.directory, key);
  }

  async retain(record: Record, bytes: Buffer, authorize: () => Promise<void>) {
    await authorize();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(this.directory, '.pending-'));
    try {
      await durableWrite(join(temporary, 'content'), bytes);
      await durableWrite(join(temporary, 'receipt.json'), Buffer.from(JSON.stringify(record)));
      await syncDirectory(temporary);
      await authorize();
      try {
        // The nonempty destination makes publication exclusive across concurrent retries and processes.
        await rename(temporary, this.path(record));
        await syncDirectory(this.directory);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code))))
          throw error;
      }
      const file = await this.open(record);
      await file.close();
      await authorize();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async open(expected: Record): Promise<FileHandle> {
    const directory = this.path(expected);
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid attachment custody directory');
    const receipt = await open(join(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await receipt.stat();
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('Invalid attachment receipt');
      const record = recordSchema.parse(JSON.parse(await receipt.readFile('utf8')));
      if (!isDeepStrictEqual(record, expected)) throw new Error('Attachment owner reference conflict');
    } finally {
      await receipt.close();
    }
    const file = await open(join(directory, 'content'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(expected.attachment.byteLength))
        throw new Error('Attachment length changed');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < expected.attachment.byteLength) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, expected.attachment.byteLength - position),
          position,
        );
        if (!bytesRead) throw new Error('Attachment read was incomplete');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (
        `sha256:${hash.digest('hex')}` !== expected.attachment.blobDigest ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error('Attachment bytes changed');
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}

async function durableWrite(path: string, bytes: Buffer) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
