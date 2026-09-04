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
  "frame-ancestors 'none'",
].join('; ');

export function sha256Sri(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

export function injectHostPolicy(html: string, assets: HostPolicyAssets): string {
  if (!html.includes('</head>')) throw new Error('renderer index has no closing head element');
  if (html.includes('http://') || html.includes('https://')) {
    throw new Error('renderer index contains an external URL before policy injection');
  }
  const withoutUpstreamPolicy = html.replace(
    /<meta\b(?=[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>\s*/giu,
    '',
  );
  const policy = [
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<link rel="stylesheet" href="${assets.policyCssPath}">`,
    `<script type="module" src="${assets.bridgePath}"></script>`,
  ].join('');
  const firstScript = withoutUpstreamPolicy.indexOf('<script');
  if (firstScript >= 0) {
    return `${withoutUpstreamPolicy.slice(0, firstScript)}${policy}${withoutUpstreamPolicy.slice(firstScript)}`;
  }
  return withoutUpstreamPolicy.replace('</head>', `${policy}</head>`);
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
