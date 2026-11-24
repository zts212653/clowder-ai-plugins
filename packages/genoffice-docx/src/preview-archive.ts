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

interface ZipEntry {
  readonly dir: boolean;
  readonly _data?: { readonly uncompressedSize?: number };
  internalStream(type: 'uint8array'): ZipStream;
}

/** Called only on entries loaded by the frozen GenOffice JSZip implementation. */
export async function readPreviewArchive(files: Record<string, ZipEntry>): Promise<Map<string, Uint8Array>> {
  const names = Object.keys(files);
  if (names.length > MAX_ENTRIES) throw new PreviewRenderError('preview_limit_exceeded');

  let total = 0;
  const parts = names.flatMap((name) => {
    const entry = files[name]!;
    if (entry.dir) return [];
    // JSZip stores non-empty entries as CompressedObjects and resets empty entries to empty input.
    const size = entry._data?.uncompressedSize ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new PreviewRenderError('preview_file_damaged');
    total += size;
    if (size > MAX_ENTRY_BYTES || total > MAX_UNPACKED_BYTES) {
      throw new PreviewRenderError('preview_limit_exceeded');
    }
    return [{ name, entry, size }];
  });

  const entries = new Map<string, Uint8Array>();
  for (const { name, entry, size } of parts) {
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
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
    entries.set(name, bytes);
  }
  return entries;
}
