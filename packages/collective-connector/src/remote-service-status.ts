import { z } from 'zod';
import type { ConnectorProjection } from './business/connector/projection.js';
import { resolveCollectivePublicUrl } from './business/service/cli-config.js';

export interface CollectiveRemoteServiceStatus {
  readonly serviceUrl: string;
  readonly state: 'unconfirmed' | 'offline' | 'instance_mismatch' | 'setup_required' | 'unpaired' | 'ready';
  /** A timeout is absence of a fresh observation, not evidence that the Service went offline. */
  readonly probe: 'completed' | 'timed_out';
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
  options: {
    readonly timeoutMs?: number;
    readonly lastCompleted?: CollectiveRemoteServiceStatus;
  } = {},
): Promise<CollectiveRemoteServiceStatus> {
  try {
    const response = await fetch(`${serviceUrl}/api/meta`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 3_000)]),
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
      probe: 'completed',
      serviceInstanceId: metadata.serviceInstanceId,
      pairedConnections: paired.filter((item) => item.serviceInstanceId === metadata.serviceInstanceId).length,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'TimeoutError') {
      return options.lastCompleted
        ? { ...options.lastCompleted, probe: 'timed_out' }
        : { serviceUrl, state: 'unconfirmed', probe: 'timed_out' };
    }
    return { serviceUrl, state: 'offline', probe: 'completed' };
  }
}

/** Keep each configured remote's last completed observation inside its plugin lifecycle. */
export function createRemoteServiceStatusReader(serviceUrl: string, signal: AbortSignal) {
  let lastCompleted: CollectiveRemoteServiceStatus | undefined;
  return async (connections: readonly ConnectorProjection[]): Promise<CollectiveRemoteServiceStatus> => {
    const status = await readRemoteServiceStatus(serviceUrl, connections, signal, { lastCompleted });
    if (status.probe === 'completed') lastCompleted = status;
    return status;
  };
}

export function remoteServiceLabel(status: CollectiveRemoteServiceStatus) {
  const address = new URL(status.serviceUrl).host;
  if (status.probe === 'timed_out')
    return `Remote Service check timed out (${address}) · The configured destination and existing data are retained while the next check retries.`;
  switch (status.state) {
    case 'unconfirmed':
      return `Remote Service status is not confirmed yet (${address}) · The configured destination is retained.`;
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
