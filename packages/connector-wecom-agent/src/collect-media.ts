const MEBIBYTE = 1024 * 1024;

// WeCom temporary-media upload (`media/upload`, document 90253):
// image 10 MiB, voice 2 MiB, ordinary file 20 MiB.
const MAX_MEDIA_BYTES = {
  image: 10 * MEBIBYTE,
  audio: 2 * MEBIBYTE,
  file: 20 * MEBIBYTE,
} as const;

export class ProviderMediaLimitError extends RangeError {
  constructor(type: keyof typeof MAX_MEDIA_BYTES) {
    super(`${type} media exceeds the provider upload limit`);
    this.name = 'ProviderMediaLimitError';
  }
}

/** Collect only for provider SDKs whose upload API requires one Buffer. */
export async function collectProviderMedia(
  type: keyof typeof MAX_MEDIA_BYTES,
  content: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    total += chunk.byteLength;
    if (total > MAX_MEDIA_BYTES[type]) throw new ProviderMediaLimitError(type);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}
