import type { ConnectorProjection } from './business/connector/projection.js';
import type { CollectiveLocalServiceStatus } from './owner-control-http.js';
import type { CollectiveRemoteServiceStatus } from './remote-service-status.js';

/** The frame consumes an address, not connection or service topology. */
export function collectiveClient(
  connections: readonly ConnectorProjection[],
  hostOrigin: string,
  remote?: CollectiveRemoteServiceStatus,
  local?: CollectiveLocalServiceStatus,
): { src: string } {
  const origin = new URL(hostOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== hostOrigin)
    throw new TypeError('Invalid Host origin');
  const candidates = remote ? connections.filter(c => c.serviceUrl === remote.serviceUrl) : connections;
  const key = (c: ConnectorProjection) => [c.serviceUrl, c.serviceInstanceId, c.collectiveId, c.connectionId].join('\0');
  const ranked = candidates.filter(c => c.authorityStatus !== 'revoked').sort((a, b) =>
    Number(b.liveStatus === 'online') - Number(a.liveStatus === 'online') ||
    Number(b.authorityStatus === 'connected') - Number(a.authorityStatus === 'connected') ||
    (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const connection = ranked[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
  const serviceUrl = connection?.serviceUrl ?? remote?.serviceUrl ?? (local?.state === 'ready' ? local.serviceUrl : undefined);
  if (!serviceUrl) return { src: '' };
  const service = new URL(serviceUrl), url = new URL('/', service.origin);
  url.searchParams.set('hostOrigin', hostOrigin);
  url.hash = service.hash;
  return { src: url.toString() };
}
