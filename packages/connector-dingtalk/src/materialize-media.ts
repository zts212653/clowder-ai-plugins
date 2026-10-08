import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface MaterializedMedia {
  readonly path: string;
  cleanup(): Promise<void>;
}

/** Materialize a Host-authorized byte stream inside a package-owned private directory. */
export async function materializeMedia(
  content: AsyncIterable<Uint8Array>,
  fileName = 'media.bin',
  maxBytes: number,
): Promise<MaterializedMedia> {
  const directory = await mkdtemp(join(tmpdir(), 'clowder-dingtalk-outbound-'));
  await chmod(directory, 0o700);
  const candidate = basename(fileName).trim();
  const safeName = candidate.length === 0 || candidate === '.' || candidate === '..' ? 'media.bin' : candidate;
  const path = join(directory, safeName);
  try {
    let totalBytes = 0;
    async function* boundedContent(): AsyncGenerator<Uint8Array> {
      for await (const chunk of content) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) throw new RangeError(`media exceeds ${maxBytes} byte platform limit`);
        yield chunk;
      }
    }
    await pipeline(Readable.from(boundedContent()), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
