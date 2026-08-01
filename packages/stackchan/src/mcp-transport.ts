import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

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

function isBrokenMcpSession(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError ||
    error instanceof UnauthorizedError ||
    (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
  );
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

  const transportOptions: StreamableHTTPClientTransportOptions = {
    requestInit: {
      headers: { Authorization: `Bearer ${options.token}` },
    },
  };
  let state: 'offline' | 'connecting' | 'online' | 'degraded' | 'closed' =
    'offline';
  let client: StackChanMcpClientLike | undefined;
  let connectPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let retirePromise: Promise<void> | undefined;

  function createClient(): StackChanMcpClientLike {
    return (
      options.createClient?.() ??
      (new Client(
        { name: '@clowder-ai/stackchan', version: '0.1.0-alpha.0' },
        { capabilities: {} },
      ) as unknown as StackChanMcpClientLike)
    );
  }

  function createTransport(): unknown {
    return (
      options.createTransport?.(endpoint, transportOptions) ??
      new StreamableHTTPClientTransport(endpoint, transportOptions)
    );
  }

  function retireClient(target: StackChanMcpClientLike): Promise<void> {
    const retirement = target.close().catch(() => undefined);
    const trackedRetirement = retirement.finally(() => {
      if (retirePromise === trackedRetirement) retirePromise = undefined;
    });
    retirePromise = trackedRetirement;
    return retirePromise;
  }

  async function connect(): Promise<void> {
    if (state === 'online') return;
    if (state === 'closed') {
      throw new Error('StackChan MCP caller is closed');
    }
    if (connectPromise) return connectPromise;
    state = 'connecting';
    connectPromise = (async () => {
      await retirePromise;
      const nextClient = createClient();
      client = nextClient;
      try {
        await nextClient.connect(createTransport());
        state = 'online';
      } catch (error) {
        if (client === nextClient) client = undefined;
        state = 'degraded';
        await retireClient(nextClient);
        throw error;
      }
    })().finally(() => {
      connectPromise = undefined;
    });
    return connectPromise;
  }

  return {
    connect,

    async callTool(
      name: string,
      input: Readonly<Record<string, unknown>>,
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<unknown> {
      if (state === 'degraded') await connect();
      if (state !== 'online') {
        throw new Error('StackChan MCP caller is not connected');
      }
      const currentClient = client;
      if (!currentClient) {
        state = 'degraded';
        throw new Error('StackChan MCP caller has no active session');
      }
      try {
        return await currentClient.callTool(
          { name, arguments: input },
          undefined,
          {
            ...(callOptions?.signal === undefined
              ? {}
              : { signal: callOptions.signal }),
            timeout: requestTimeoutMs,
          },
        );
      } catch (error) {
        if (client === currentClient && isBrokenMcpSession(error)) {
          client = undefined;
          state = 'degraded';
          await retireClient(currentClient);
        }
        throw error;
      }
    },

    async close(): Promise<void> {
      if (state === 'closed') return;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await connectPromise?.catch(() => undefined);
        await retirePromise;
        const currentClient = client;
        client = undefined;
        if (currentClient) await currentClient.close();
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
