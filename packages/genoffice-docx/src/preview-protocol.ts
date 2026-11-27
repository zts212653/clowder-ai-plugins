/**
 * Read-only preview protocol (contract 1.0.0).
 *
 * Pure functions only: the browser glue lives in `preview/bridge.ts`, so this
 * module can be unit-tested with node:test without a DOM.
 */

export const PREVIEW_BRIDGE_VERSION = '1.0.0' as const;

export interface PreviewBootstrap {
  readonly parentOrigin: string;
  readonly handshakeNonce: string;
}

export interface PreviewSnapshot {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
}

export const PREVIEW_MEDIA_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type PreviewFormat = keyof typeof PREVIEW_MEDIA_TYPES;

const NONCE_PATTERN = /^handshake_[A-Za-z0-9_-]{32,128}$/u;
const MAX_FILE_NAME = 512;

/** Parse and validate the fragment the Host appends to the surface URL. */
export function readBootstrap(hash: string, currentOrigin: string): PreviewBootstrap {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const parentOrigin = params.get('cat-cafe-parent-origin') ?? '';
  const handshakeNonce = params.get('cat-cafe-handshake') ?? '';
  if (!isOrigin(parentOrigin)) throw new Error('preview_parent_origin_invalid');
  // A preview renderer is served from a dedicated origin; same-origin framing is a Host bug.
  if (parentOrigin === currentOrigin) throw new Error('preview_origin_not_dedicated');
  if (!NONCE_PATTERN.test(handshakeNonce)) throw new Error('preview_handshake_invalid');
  return { parentOrigin, handshakeNonce };
}

export function isConnectMessage(
  value: unknown,
  handshakeNonce: string,
): value is {
  readonly v: 1;
  readonly kind: 'cat-cafe-content-preview-connect';
  readonly handshakeNonce: string;
  readonly bridgeVersion: string;
} {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    value.kind === 'cat-cafe-content-preview-connect' &&
    value.handshakeNonce === handshakeNonce &&
    value.bridgeVersion === PREVIEW_BRIDGE_VERSION
  );
}

export function isSnapshotMessage(
  value: unknown,
  allowedMediaTypes: ReadonlySet<string>,
): value is {
  readonly v: 1;
  readonly kind: 'cat-cafe-content-preview-snapshot';
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
} {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    value.kind === 'cat-cafe-content-preview-snapshot' &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0 &&
    value.fileName.length <= MAX_FILE_NAME &&
    !value.fileName.includes('\0') &&
    typeof value.mediaType === 'string' &&
    allowedMediaTypes.has(value.mediaType) &&
    value.bytes instanceof ArrayBuffer &&
    value.bytes.byteLength > 0
  );
}

/** Format dispatch for one snapshot, by declared media type. */
export function previewFormatFor(mediaType: string): PreviewFormat | null {
  for (const [format, type] of Object.entries(PREVIEW_MEDIA_TYPES)) {
    if (type === mediaType) return format as PreviewFormat;
  }
  return null;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          (url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '[::1]' ||
            url.hostname.endsWith('.localhost'))))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
