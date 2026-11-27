import { PreviewRenderError } from './preview-errors.js';

const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

interface ZipStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): this;
  on(event: 'end', callback: () => void): this;
  on(event: 'error', callback: (error: Error) => void): this;
  pause(): this;
  resume(): this;
}

export interface PreviewZipEntry {
  readonly dir: boolean;
  readonly _data?: { readonly uncompressedSize?: number };
  internalStream(type: 'uint8array'): ZipStream;
}

/**
 * Declared uncompressed size of one entry, rejecting anything the budget forbids.
 *
 * JSZip stores non-empty entries as CompressedObjects and resets empty entries to
 * empty input, so a missing size can only mean an entry we cannot bound.
 */
function declaredEntrySize(entry: PreviewZipEntry): number {
  const size = entry._data?.uncompressedSize ?? 0;
  if (!Number.isSafeInteger(size) || size < 0) throw new PreviewRenderError('preview_file_damaged');
  return size;
}

function assertWithinBudget(size: number, spent: number): void {
  if (size > MAX_ENTRY_BYTES || spent + size > MAX_UNPACKED_BYTES) {
    throw new PreviewRenderError('preview_limit_exceeded');
  }
}

/** Decompress exactly one entry, never growing past the size its header declared. */
async function readEntryBytes(entry: PreviewZipEntry, size: number): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const result = new Uint8Array(size);
    const stream = entry.internalStream('uint8array');
    let offset = 0;
    stream.on('data', (chunk) => {
      if (chunk.length > result.length - offset) {
        stream.pause();
        reject(new PreviewRenderError('preview_limit_exceeded'));
        return;
      }
      result.set(chunk, offset);
      offset += chunk.length;
    }).on('error', reject).on('end', () => {
      if (offset === result.length) resolve(result);
      else reject(new PreviewRenderError('preview_file_damaged'));
    }).resume();
  });
}

/** Called only on entries loaded by the frozen GenOffice JSZip implementation. */
export async function readPreviewArchive(files: Record<string, PreviewZipEntry>): Promise<Map<string, Uint8Array>> {
  const names = Object.keys(files);
  if (names.length > MAX_ENTRIES) throw new PreviewRenderError('preview_limit_exceeded');

  let total = 0;
  const parts = names.flatMap((name) => {
    const entry = files[name]!;
    if (entry.dir) return [];
    const size = declaredEntrySize(entry);
    assertWithinBudget(size, total);
    total += size;
    return [{ name, entry, size }];
  });

  const entries = new Map<string, Uint8Array>();
  for (const { name, entry, size } of parts) {
    entries.set(name, await readEntryBytes(entry, size));
  }
  return entries;
}

/**
 * Bounded reader over a subset of archive entries, as text.
 *
 * The XLSX extractor reads a handful of named parts (`xl/workbook.xml`, the
 * workbook rels, shared strings, one part per worksheet) instead of the whole
 * package, so it cannot use `readPreviewArchive` (which decompresses everything).
 * This keeps the same per-entry bound and charges every read against one running
 * total, so a workbook with many large sheets still hits the same ceiling.
 */
export function createPreviewEntryReader(files: Record<string, PreviewZipEntry>): {
  readText(path: string): Promise<string | undefined>;
} {
  const names = Object.keys(files);
  if (names.length > MAX_ENTRIES) throw new PreviewRenderError('preview_limit_exceeded');

  let total = 0;
  return {
    async readText(path: string) {
      const entry = files[path];
      if (!entry || entry.dir) return undefined;
      const size = declaredEntrySize(entry);
      assertWithinBudget(size, total);
      total += size;
      const bytes = await readEntryBytes(entry, size);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    },
  };
}
