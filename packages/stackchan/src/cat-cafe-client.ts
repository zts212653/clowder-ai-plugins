import type { PhysicalLimbObservation } from '@clowder-ai/plugin-contract';
import { isPhysicalLimbObservation } from './physical-limb-validator.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CatCafeLimbCapability {
  readonly cap: string;
  readonly commands: readonly string[];
  readonly authLevel: 'free' | 'leased' | 'gated';
}

export interface CatCafeLimbRegistration {
  readonly requestId: string;
  readonly apiKey: string;
  readonly status: 'pending' | 'approved' | 'rejected';
}

export type CatCafeObservationReceipt =
  | { readonly status: 'reflex_only' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'routed'; readonly messageId: string };

export interface CatCafeLimbClientOptions {
  readonly baseUrl: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly endpointUrl: string;
  readonly capabilities: readonly CatCafeLimbCapability[];
  readonly apiKey?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onApiKeyChanged?: (apiKey: string) => void | Promise<void>;
}

export interface CatCafeLimbClient {
  register(): Promise<CatCafeLimbRegistration>;
  heartbeat(): Promise<void>;
  emitObservation(observation: PhysicalLimbObservation): Promise<CatCafeObservationReceipt>;
  deregister(): Promise<void>;
  getApiKey(): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Cat Cafe response exceeds 64 KiB');
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader
            .cancel('Cat Cafe response exceeds 64 KiB')
            .catch(() => undefined);
          throw new Error('Cat Cafe response exceeds 64 KiB');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Cat Cafe returned invalid JSON');
  }
}

function validateOptions(options: CatCafeLimbClientOptions): URL {
  const baseUrl = new URL(options.baseUrl);
  const endpointUrl = new URL(options.endpointUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') ||
    !validIdentifier(options.nodeId) ||
    !validIdentifier(options.displayName) ||
    options.displayName.length > 256 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000 ||
    (options.apiKey !== undefined && options.apiKey.length < 8) ||
    options.capabilities.length === 0 ||
    options.capabilities.some(
      (capability) =>
        !validIdentifier(capability.cap) ||
        !['free', 'leased', 'gated'].includes(capability.authLevel) ||
        capability.commands.some((command) => !validIdentifier(command)),
    )
  ) {
    throw new TypeError('Invalid Cat Cafe limb client configuration');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '');
  return baseUrl;
}

function parseRegistration(raw: unknown): CatCafeLimbRegistration {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['requestId', 'apiKey', 'status']) ||
    !validIdentifier(raw.requestId) ||
    typeof raw.apiKey !== 'string' ||
    raw.apiKey.length < 8 ||
    (raw.status !== 'pending' && raw.status !== 'approved' && raw.status !== 'rejected')
  ) {
    throw new Error('Cat Cafe returned an invalid registration response');
  }
  return raw as unknown as CatCafeLimbRegistration;
}

function parseObservationReceipt(raw: unknown): CatCafeObservationReceipt {
  if (!isRecord(raw) || typeof raw.status !== 'string') {
    throw new Error('Cat Cafe returned an invalid observation response');
  }
  if (
    (raw.status === 'reflex_only' || raw.status === 'duplicate') &&
    hasExactKeys(raw, ['status'])
  ) {
    return raw as CatCafeObservationReceipt;
  }
  if (
    raw.status === 'routed' &&
    hasExactKeys(raw, ['status', 'messageId']) &&
    validIdentifier(raw.messageId)
  ) {
    return raw as unknown as CatCafeObservationReceipt;
  }
  throw new Error('Cat Cafe returned an invalid observation response');
}

export function createCatCafeLimbClient(options: CatCafeLimbClientOptions): CatCafeLimbClient {
  const baseUrl = validateOptions(options);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let apiKey = options.apiKey;

  async function post(path: string, body: unknown, authenticated: boolean): Promise<unknown> {
    if (authenticated && apiKey === undefined) {
      throw new Error('StackChan limb is not registered');
    }
    const response = await fetchFn(new URL(path, baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await readBoundedJson(response);
    if (!response.ok) {
      throw new Error(`Cat Cafe request failed with HTTP ${response.status}`);
    }
    return parsed;
  }

  return {
    async register(): Promise<CatCafeLimbRegistration> {
      const registration = parseRegistration(
        await post(
          '/api/limb/register',
          {
            nodeId: options.nodeId,
            displayName: options.displayName,
            platform: 'stackchan',
            endpointUrl: options.endpointUrl,
            capabilities: options.capabilities,
            ...(apiKey === undefined ? {} : { apiKey }),
          },
          false,
        ),
      );
      if (registration.apiKey !== apiKey) {
        apiKey = registration.apiKey;
        await options.onApiKeyChanged?.(apiKey);
      }
      return registration;
    },

    async heartbeat(): Promise<void> {
      await post('/api/limb/heartbeat', { apiKey, nodeId: options.nodeId }, true);
    },

    async emitObservation(
      observation: PhysicalLimbObservation,
    ): Promise<CatCafeObservationReceipt> {
      if (!isPhysicalLimbObservation(observation)) {
        throw new TypeError('Invalid StackChan observation');
      }
      return parseObservationReceipt(
        await post('/api/limb/observations', { observation }, true),
      );
    },

    async deregister(): Promise<void> {
      await post('/api/limb/deregister', { apiKey, nodeId: options.nodeId }, true);
    },

    getApiKey(): string | undefined {
      return apiKey;
    },
  };
}
