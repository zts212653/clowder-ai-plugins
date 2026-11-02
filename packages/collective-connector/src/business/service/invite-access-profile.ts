import { isIP } from 'node:net';

export interface InviteAccessProfile {
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshHostFingerprint: string;
  readonly serviceHost: '127.0.0.1' | '::1';
  readonly servicePort: number;
  readonly cafeSourceRevision?: string;
  readonly cafePublicRevision?: string;
}

/** Read operator-configured public connection coordinates, never keys or credentials. */
export function readInviteAccessProfile(
  environment: NodeJS.ProcessEnv,
  localAddress: string | undefined,
  localPort: number | undefined,
): InviteAccessProfile | undefined {
  const host = environment.COLLECTIVE_INVITE_SSH_HOST?.trim() ?? '';
  const port = environment.COLLECTIVE_INVITE_SSH_PORT?.trim() ?? '';
  const fingerprint = environment.COLLECTIVE_INVITE_SSH_FINGERPRINT?.trim() ?? '';
  const cafeSourceRevision = environment.COLLECTIVE_INVITE_CAFE_SOURCE_REVISION?.trim() || undefined;
  const cafePublicRevision = environment.COLLECTIVE_INVITE_CAFE_PUBLIC_REVISION?.trim() || undefined;
  const serviceHost = localAddress === '::ffff:127.0.0.1' ? '127.0.0.1' : localAddress;
  if (!validHost(host) || !/^\d{1,5}$/.test(port)) return undefined;
  const sshPort = Number(port);
  if (sshPort < 1 || sshPort > 65_535 || !validFingerprint(fingerprint)) return undefined;
  if (
    (cafeSourceRevision && !/^[a-f0-9]{40}$/.test(cafeSourceRevision)) ||
    (cafePublicRevision && !/^[a-f0-9]{40}$/.test(cafePublicRevision))
  ) return undefined;
  if (serviceHost !== '127.0.0.1' && serviceHost !== '::1') return undefined;
  if (!localPort || localPort < 1 || localPort > 65_535) return undefined;
  return {
    sshHost: host, sshPort, sshHostFingerprint: fingerprint, serviceHost, servicePort: localPort,
    ...(cafeSourceRevision ? { cafeSourceRevision } : {}),
    ...(cafePublicRevision ? { cafePublicRevision } : {}),
  };
}

function validHost(host: string): boolean {
  if (host.length < 1 || host.length > 253 || host.includes('%') || host.toLowerCase() === 'localhost') return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const first = Number(host.split('.')[0]);
    return first > 0 && first !== 127 && first < 224;
  }
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('::ffff:') && !normalized.startsWith('ff');
  }
  if (/^[\d.]+$/.test(host)) return false;
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function validFingerprint(value: string): boolean {
  const match = /^SHA256:([A-Za-z0-9+/]{43})$/.exec(value);
  if (!match?.[1]) return false;
  const decoded = Buffer.from(match[1], 'base64');
  return decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === match[1];
}
