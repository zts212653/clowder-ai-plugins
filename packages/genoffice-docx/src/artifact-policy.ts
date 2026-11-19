import { createHash } from 'node:crypto';

export interface HostPolicyAssets {
  bridgePath: string;
  policyCssPath: string;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function sha256Sri(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function withoutUpstreamPolicy(html: string): string {
  if (!html.includes('</head>')) throw new Error('renderer index has no closing head element');
  if (html.includes('http://') || html.includes('https://')) {
    throw new Error('renderer index contains an external URL before policy injection');
  }
  return html.replace(
    /<meta\b(?=[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>\s*/giu,
    '',
  );
}

function insertPolicy(html: string, policy: string): string {
  const firstScript = html.indexOf('<script');
  if (firstScript >= 0) return `${html.slice(0, firstScript)}${policy}${html.slice(firstScript)}`;
  return html.replace('</head>', `${policy}</head>`);
}

export function injectHostPolicy(html: string, assets: HostPolicyAssets): string {
  const stripped = withoutUpstreamPolicy(html);
  const policy = [
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<link rel="stylesheet" href="${assets.policyCssPath}">`,
    `<script type="module" src="${assets.bridgePath}"></script>`,
  ].join('');
  return insertPolicy(stripped, policy);
}

/** Preview surfaces carry the same CSP but no Host bridge script: the preview
 * protocol is bundled into the renderer itself. */
export function injectPreviewPolicy(html: string, assets: { policyCssPath: string }): string {
  const stripped = withoutUpstreamPolicy(html);
  const policy = [
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<link rel="stylesheet" href="${assets.policyCssPath}">`,
  ].join('');
  return insertPolicy(stripped, policy);
}

const FORBIDDEN_PACK_PATTERNS: readonly RegExp[] = [
  /(^|\/)ee(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(main|preload)(\/|$)/i,
  /(^|\/)electron(?:[./-]|$)/i,
  /(^|\/)upstream-source(\/|$)/i,
  /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|\/|$)|secrets?(?:\.|\/|$))/i,
];

export function assertPackEntries(entries: readonly string[]): void {
  for (const rawEntry of entries) {
    const entry = rawEntry.replaceAll('\\', '/');
    if (
      entry.startsWith('/') ||
      entry.split('/').includes('..') ||
      FORBIDDEN_PACK_PATTERNS.some((pattern) => pattern.test(entry))
    ) {
      throw new Error(`forbidden pack entry: ${rawEntry}`);
    }
  }
}
