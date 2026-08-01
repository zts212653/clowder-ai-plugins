import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  PhysicalLimbAction,
  PhysicalLimbActionResult,
  PhysicalLimbCancel,
} from '@clowder-ai/plugin-contract';
import type { StackChanActionExecutor } from './action-executor.js';

const require = createRequire(import.meta.url);
interface AjvValidateFunction {
  (data: unknown): boolean;
}
interface AjvInstance {
  addSchema(schema: Record<string, unknown>): void;
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}
const Ajv2020 = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => AjvInstance;
const addFormats = require('ajv-formats') as (ajv: AjvInstance) => void;
const physicalLimbSchema = require(
  '@clowder-ai/plugin-contract/schemas/physical-limb',
) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(physicalLimbSchema);
const validateInstruction = ajv.compile({
  anyOf: [
    { $ref: 'https://clowder-ai.dev/schemas/physical-limb/v0.1#/$defs/PhysicalLimbAction' },
    { $ref: 'https://clowder-ai.dev/schemas/physical-limb/v0.1#/$defs/PhysicalLimbCancel' },
  ],
});

const MAX_REQUEST_BYTES = 64 * 1024;

export interface StackChanRemoteLimbServerOptions {
  readonly nodeId: string;
  readonly apiKey: string;
  readonly executor: StackChanActionExecutor;
  readonly health: () => Promise<'online' | 'busy' | 'degraded' | 'offline'>;
  readonly host?: string;
  readonly port?: number;
}

export interface StackChanRemoteLimbServerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface StackChanRemoteLimbServer {
  start(): Promise<StackChanRemoteLimbServerAddress>;
  stop(): Promise<void>;
}

class PayloadTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isAuthorized(header: string | undefined, apiKey: string): boolean {
  const actual = Buffer.from(header ?? '', 'utf8');
  const expected = Buffer.from(`Bearer ${apiKey}`, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new TypeError('content-type must be application/json');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new PayloadTooLargeError('request body exceeds 64 KiB');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new TypeError('request body must be valid JSON');
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

function parseInvokeBody(raw: unknown): PhysicalLimbAction | PhysicalLimbCancel {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['command', 'params']) ||
    raw.command !== 'physical_limb.execute' ||
    !isRecord(raw.params) ||
    !hasExactKeys(raw.params, ['instruction']) ||
    !validateInstruction(raw.params.instruction)
  ) {
    throw new TypeError('invalid or unsupported physical limb invocation');
  }
  return raw.params.instruction as PhysicalLimbAction | PhysicalLimbCancel;
}

function toInvokeResult(result: PhysicalLimbActionResult): {
  success: boolean;
  data: PhysicalLimbActionResult;
  error?: string;
} {
  const success = result.outcome === 'succeeded' || result.outcome === 'canceled';
  return {
    success,
    data: result,
    ...(success ? {} : { error: result.reason ?? `physical action ${result.outcome}` }),
  };
}

export function createStackChanRemoteLimbServer(
  options: StackChanRemoteLimbServerOptions,
): StackChanRemoteLimbServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8788;
  if (
    options.nodeId.length === 0 ||
    options.apiKey.length < 8 ||
    (host !== '127.0.0.1' && host !== '::1') ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new TypeError('Invalid StackChan Remote Limb server configuration');
  }

  let server: Server | undefined;
  let currentAddress: StackChanRemoteLimbServerAddress | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request.headers.authorization, options.apiKey)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: await options.health() });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/invoke') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    try {
      const instruction = parseInvokeBody(await readJsonBody(request));
      if (instruction.nodeId !== options.nodeId) {
        sendJson(response, 403, { error: 'Node mismatch' });
        return;
      }
      sendJson(response, 200, toInvokeResult(await options.executor.execute(instruction)));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: error.message });
      } else if (error instanceof TypeError) {
        sendJson(response, 400, { error: error.message });
      } else {
        sendJson(response, 500, { error: 'StackChan invocation failed' });
      }
    }
  }

  return {
    async start(): Promise<StackChanRemoteLimbServerAddress> {
      if (currentAddress) return currentAddress;
      server = createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) sendJson(response, 500, { error: 'StackChan server failure' });
          else response.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, () => {
          server!.off('error', reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      currentAddress = {
        host,
        port: address.port,
        url: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
      };
      return currentAddress;
    },

    async stop(): Promise<void> {
      const active = server;
      server = undefined;
      currentAddress = undefined;
      if (!active) return;
      await new Promise<void>((resolve, reject) => {
        active.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
