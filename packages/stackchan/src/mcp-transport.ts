import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { StackChanMcpToolCaller } from './gateway-client.js';

const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface StackChanMcpClientLike {
  connect(transport: unknown): Promise<void>;
  callTool(
    params: {
      readonly name: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
    },
    resultSchema?: undefined,
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface StackChanStreamableHttpMcpCaller extends StackChanMcpToolCaller {
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): 'offline' | 'online' | 'degraded';
}

export interface StackChanStreamableHttpMcpCallerOptions {
  readonly endpointUrl: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly createClient?: () => StackChanMcpClientLike;
  readonly createTransport?: (
    url: URL,
    options: StreamableHTTPClientTransportOptions,
  ) => unknown;
}

function validateEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('StackChan MCP endpoint must be a valid URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.pathname !== '/mcp' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError('StackChan MCP endpoint must not contain credentials');
    }
    throw new TypeError('StackChan MCP endpoint must be a loopback /mcp URL');
  }
  return url;
}

function validateToken(token: string): void {
  if (
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new TypeError('StackChan MCP bearer token is missing or invalid');
  }
}

export function createStackChanStreamableHttpMcpCaller(
  options: StackChanStreamableHttpMcpCallerOptions,
): StackChanStreamableHttpMcpCaller {
  const endpoint = validateEndpoint(options.endpointUrl);
  validateToken(options.token);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000
  ) {
    throw new TypeError('Invalid StackChan MCP request timeout');
  }

  const client =
    options.createClient?.() ??
    (new Client(
      { name: '@clowder-ai/stackchan', version: '0.1.0-alpha.0' },
      { capabilities: {} },
    ) as unknown as StackChanMcpClientLike);
  const transportOptions: StreamableHTTPClientTransportOptions = {
    requestInit: {
      headers: { Authorization: `Bearer ${options.token}` },
    },
  };
  const transport =
    options.createTransport?.(endpoint, transportOptions) ??
    new StreamableHTTPClientTransport(endpoint, transportOptions);

  let state: 'offline' | 'connecting' | 'online' | 'degraded' | 'closed' =
    'offline';
  let connectPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    async connect(): Promise<void> {
      if (state === 'online') return;
      if (state === 'closed') {
        throw new Error('StackChan MCP caller is closed');
      }
      if (connectPromise) return connectPromise;
      state = 'connecting';
      connectPromise = client
        .connect(transport)
        .then(() => {
          state = 'online';
        })
        .catch((error: unknown) => {
          state = 'degraded';
          throw error;
        })
        .finally(() => {
          connectPromise = undefined;
        });
      return connectPromise;
    },

    async callTool(
      name: string,
      input: Readonly<Record<string, unknown>>,
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<unknown> {
      if (state !== 'online') {
        throw new Error('StackChan MCP caller is not connected');
      }
      return client.callTool(
        { name, arguments: input },
        undefined,
        {
          ...(callOptions?.signal === undefined
            ? {}
            : { signal: callOptions.signal }),
          timeout: requestTimeoutMs,
        },
      );
    },

    async close(): Promise<void> {
      if (state === 'closed') return;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await connectPromise?.catch(() => undefined);
        await client.close();
        state = 'closed';
      })().finally(() => {
        closePromise = undefined;
      });
      return closePromise;
    },

    status(): 'offline' | 'online' | 'degraded' {
      if (state === 'online') return 'online';
      if (state === 'degraded') return 'degraded';
      return 'offline';
    },
  };
}
