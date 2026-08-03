import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_READ_CHUNK_BYTES = 16 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

export interface StackChanEventCursor {
  fileId: string;
  offset: number;
  pendingBase64: string;
  droppingOversize: boolean;
}

export interface StackChanEventCursorStore {
  load(): Promise<StackChanEventCursor | undefined>;
  save(cursor: StackChanEventCursor): Promise<void>;
}

export interface StackChanJsonlEventSourceOptions {
  path: string;
  cursorStore: StackChanEventCursorStore;
  onEvent(event: Record<string, unknown>): void | Promise<void>;
  readChunkBytes?: number;
  maxLineBytes?: number;
}

export interface StackChanJsonlEventSource {
  pollOnce(): Promise<number>;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function emptyCursor(fileId: string): StackChanEventCursor {
  return {
    fileId,
    offset: 0,
    pendingBase64: '',
    droppingOversize: false,
  };
}

function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isUsableCursor(cursor: unknown): cursor is StackChanEventCursor {
  return Boolean(
    typeof cursor === 'object' &&
      cursor !== null &&
      !Array.isArray(cursor) &&
      'fileId' in cursor &&
      'offset' in cursor &&
      'pendingBase64' in cursor &&
      'droppingOversize' in cursor &&
      typeof cursor.fileId === 'string' &&
      cursor.fileId.length > 0 &&
      Number.isSafeInteger(cursor.offset) &&
      (cursor.offset as number) >= 0 &&
      typeof cursor.pendingBase64 === 'string' &&
      isCanonicalBase64(cursor.pendingBase64) &&
      typeof cursor.droppingOversize === 'boolean',
  );
}

export function createFileStackChanCursorStore(path: string): StackChanEventCursorStore {
  if (path.length === 0) {
    throw new TypeError('cursor path must not be empty');
  }

  return {
    async load(): Promise<StackChanEventCursor | undefined> {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }

      try {
        const parsed: unknown = JSON.parse(text);
        return isUsableCursor(parsed) ? structuredClone(parsed) : undefined;
      } catch {
        return undefined;
      }
    },

    async save(cursor: StackChanEventCursor): Promise<void> {
      if (!isUsableCursor(cursor)) {
        throw new TypeError('refusing to persist invalid StackChan event cursor');
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(cursor)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

function decodeJsonObject(line: Buffer): Record<string, unknown> | undefined {
  const withoutCarriageReturn = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  if (withoutCarriageReturn.length === 0) {
    return undefined;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(withoutCarriageReturn);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function createStackChanJsonlEventSource(
  options: StackChanJsonlEventSourceOptions,
): StackChanJsonlEventSource {
  if (options.path.length === 0) {
    throw new TypeError('path must not be empty');
  }
  const readChunkBytes = requirePositiveInteger(
    'readChunkBytes',
    options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES,
  );
  const maxLineBytes = requirePositiveInteger(
    'maxLineBytes',
    options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
  );

  return {
    async pollOnce(): Promise<number> {
      let handle;
      try {
        handle = await open(options.path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0;
        }
        throw error;
      }

      try {
        const metadata = await handle.stat();
        const fileId = `${metadata.dev}:${metadata.ino}`;
        const loaded = await options.cursorStore.load();
        let cursor =
          isUsableCursor(loaded) && loaded.fileId === fileId && loaded.offset <= metadata.size
            ? structuredClone(loaded)
            : emptyCursor(fileId);

        let pending: Buffer;
        try {
          pending = Buffer.from(cursor.pendingBase64, 'base64');
        } catch {
          cursor = emptyCursor(fileId);
          pending = Buffer.alloc(0);
        }
        if (pending.length > maxLineBytes) {
          pending = Buffer.alloc(0);
          cursor.droppingOversize = true;
        }

        let emitted = 0;
        const chunk = Buffer.allocUnsafe(readChunkBytes);

        while (cursor.offset < metadata.size) {
          const bytesToRead = Math.min(readChunkBytes, metadata.size - cursor.offset);
          const { bytesRead } = await handle.read(chunk, 0, bytesToRead, cursor.offset);
          if (bytesRead === 0) {
            break;
          }
          cursor.offset += bytesRead;

          let start = 0;
          for (let index = 0; index < bytesRead; index += 1) {
            if (chunk[index] !== 0x0a) {
              continue;
            }

            const segment = chunk.subarray(start, index);
            start = index + 1;
            if (cursor.droppingOversize) {
              cursor.droppingOversize = false;
              pending = Buffer.alloc(0);
              continue;
            }

            const line = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
            pending = Buffer.alloc(0);
            if (line.length > maxLineBytes) {
              continue;
            }
            const event = decodeJsonObject(line);
            if (event) {
              await options.onEvent(event);
              emitted += 1;
            }
          }

          if (start < bytesRead) {
            const tail = chunk.subarray(start, bytesRead);
            if (!cursor.droppingOversize) {
              if (pending.length + tail.length > maxLineBytes) {
                pending = Buffer.alloc(0);
                cursor.droppingOversize = true;
              } else {
                pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
              }
            }
          }
        }

        cursor.pendingBase64 = pending.toString('base64');
        await options.cursorStore.save(cursor);
        return emitted;
      } finally {
        await handle.close();
      }
    },
  };
}
