import { z } from 'zod';
import type { ConnectorProjection } from './business/connector/projection.js';
import { resolveCollectivePublicUrl } from './business/service/cli-config.js';

export interface CollectiveRemoteServiceStatus {
  readonly serviceUrl: string;
  readonly state: 'offline' | 'instance_mismatch' | 'setup_required' | 'unpaired' | 'ready';
  readonly serviceInstanceId?: string;
  readonly pairedConnections?: number;
}
const metadataSchema = z.object({
  serviceInstanceId: z.string().regex(/^svc_[A-Za-z0-9_-]{8,150}$/),
  bootstrapNeeded: z.boolean(),
  onboardingComplete: z.boolean(),
});

export function remoteServiceUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Remote Service address is required');
  const parsed = new URL(value.trim());
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || ['3001', '3002'].includes(parsed.port))
    throw new Error('Remote Service address must be its root URL on a non-reserved port');
  return new URL(resolveCollectivePublicUrl(value, '127.0.0.1', 15201)).origin;
}

export async function readRemoteServiceStatus(
  serviceUrl: string,
  connections: readonly ConnectorProjection[],
  signal: AbortSignal,
): Promise<CollectiveRemoteServiceStatus> {
  try {
    const response = await fetch(`${serviceUrl}/api/meta`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Remote metadata is unavailable');
    const metadata = metadataSchema.parse(await response.json());
    const paired = connections.filter((item) => item.serviceUrl === serviceUrl && item.authorityStatus !== 'revoked');
    const state = paired.some((item) => item.serviceInstanceId !== metadata.serviceInstanceId)
      ? 'instance_mismatch'
      : !metadata.onboardingComplete
        ? 'setup_required'
        : paired.length
          ? 'ready'
          : 'unpaired';
    return {
      serviceUrl,
      state,
      serviceInstanceId: metadata.serviceInstanceId,
      pairedConnections: paired.filter((item) => item.serviceInstanceId === metadata.serviceInstanceId).length,
    };
  } catch {
    signal.throwIfAborted();
    return { serviceUrl, state: 'offline' };
  }
}

export function remoteServiceLabel(status: CollectiveRemoteServiceStatus) {
  const address = new URL(status.serviceUrl).host;
  switch (status.state) {
    case 'offline':
      return `Cannot reach remote Service (${address}) · Check the SSH tunnel and Service. Existing connections and data are retained.`;
    case 'instance_mismatch':
      return 'This address reaches a different Service · Original connections remain unchanged. Check the SSH destination.';
    case 'setup_required':
      return 'Remote Service is online · Open Collective to finish its initial setup.';
    case 'unpaired':
      return 'Remote Service is online · Open Collective to sign in and pair this Café.';
    case 'ready':
      return `Remote Service is online · ${status.pairedConnections} paired connection(s)`;
  }
}
