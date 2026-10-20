import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  DELIVERY_REJECTED_CODE,
  DELIVERY_REJECTED_MESSAGE,
  DELIVERY_REJECT_REASONS,
  METHOD_NOT_FOUND_CODE,
  METHOD_NOT_FOUND_MESSAGE,
  PARSE_ERROR_CODE,
  PARSE_ERROR_MESSAGE,
  validateManifest,
  isPluginDeliveryInput,
  isPluginDeliveryReceipt,
  type DeliverInput,
  type PluginDeliveryReceipt,
  type DeliveryRejectReason,
  type ManifestValidationError,
  type PluginManifest,
} from '@clowder-ai/plugin-contract';

import {
  createStdioChannel,
  startStdioRuntime,
  type JsonObject,
  type StdioChannel,
  type StdioFrameErrorHandler,
  type StdioRuntimeFatalError,
} from './stdio-runtime.js';
import { classifyFrame, type InFlightEntry } from '@clowder-ai/plugin-contract';

export class ManifestStartupError extends Error {
  readonly errors: readonly ManifestValidationError[];

  constructor(errors: readonly ManifestValidationError[]) {
    super('plugin manifest failed contract validation');
    this.name = 'ManifestStartupError';
    this.errors = errors;
  }
}

export interface StandaloneHostOptions {
  /** Untrusted manifest content; it is validated before stdio starts. */
  readonly manifest: unknown;
  /** Caller-owned streams are useful for embedding and tests; provide both or neither. */
  readonly input?: Readable;
  readonly output?: Writable;


  /** A receipt acknowledges only this delivery input. */
  readonly delivery?: StandaloneDeliveryHandler;
  readonly onFatal?: (error: StdioRuntimeFatalError) => void;
}

export type StandaloneDeliveryHandler = (input: DeliverInput) => PluginDeliveryReceipt | Promise<PluginDeliveryReceipt>;

export interface StandaloneHost extends StdioChannel {
  readonly manifest: PluginManifest;
}

class StandaloneProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneProtocolError';
  }
}

function requireValidManifest(value: unknown): PluginManifest {
  const validation = validateManifest(value);
  if (!validation.valid) {
    throw new ManifestStartupError(validation.errors);
  }
  return validation.manifest;
}

function requireStdioManifest(value: unknown): PluginManifest {
  const manifest = requireValidManifest(value);
  if (manifest.runtime?.transport !== 'stdio') {
    throw new TypeError('standalone stdio host requires a manifest with runtime.transport "stdio"');
  }
  return manifest;
}

/**
 * Loads and contract-validates a manifest file for a standalone plugin.
 *
 * File and JSON parsing errors deliberately propagate: callers have not yet
 * started a transport, so no protocol peer can observe a partial startup.
 */
export async function loadStandaloneManifest(path: string | URL): Promise<PluginManifest> {
  return requireValidManifest(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRequest(value: JsonObject): {
  readonly id: string;
  readonly method: string;
  readonly input: JsonObject;
} {
  const { id, method, params } = value;
  if (typeof id !== 'string' || typeof method !== 'string' || !isObject(params) || !isObject(params.input)) {
    throw new StandaloneProtocolError('classifier accepted a frame outside the standalone request boundary');
  }
  return { id, method, input: params.input };
}



function methodNotFoundResponse(id: string): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: METHOD_NOT_FOUND_CODE, message: METHOD_NOT_FOUND_MESSAGE },
  };
}

function deliveryRejectedResponse(id: string, reason: DeliveryRejectReason): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: DELIVERY_REJECTED_CODE,
      message: DELIVERY_REJECTED_MESSAGE,
      data: { reason },
    },
  };
}

const HOST_BOUND_REQUEST_METHODS = new Set([
  'broker.hello',
  'broker.ready',
  'messaging.send',
  'messaging.appendElements',
  'messaging.subscribe',
  'messaging.read',
  'messaging.ack',
  'messaging.snapshot',
  'streams.read',
]);

async function dispatchMessage(id: string, input: JsonObject, delivery: StandaloneHostOptions['delivery']): Promise<JsonObject> {
  if (!delivery) return deliveryRejectedResponse(id, 'NO_HANDLER');
  if (!isPluginDeliveryInput(input)) return deliveryRejectedResponse(id, 'PLUGIN_INTERNAL');
  try {
    const receipt = await delivery(structuredClone(input));
    if (!isPluginDeliveryReceipt(receipt) || receipt.deliveryId !== input.deliveryId) {
      return deliveryRejectedResponse(id, 'PLUGIN_INTERNAL');
    }
    return {jsonrpc: '2.0', id, result: {deliveryId: receipt.deliveryId}};
  } catch {
    return deliveryRejectedResponse(id, 'PLUGIN_INTERNAL');
  }
}



function createFrameHandler(options: StandaloneHostOptions) {
  const inFlight = new Map<string, InFlightEntry>();

  return async (frame: Parameters<typeof classifyFrame>[0]): Promise<JsonObject | undefined> => {
    const dispatch = classifyFrame(frame, inFlight);
    if (dispatch.outcome === 'respond') {
      if (dispatch.response === undefined) {
        throw new StandaloneProtocolError('classifier requested a response without an envelope');
      }
      return dispatch.response;
    }
    if (dispatch.outcome === 'close') {
      throw new StandaloneProtocolError(`classifier rejected frame as ${dispatch.disposition ?? 'unknown'}`);
    }



    const request = requireRequest(frame.value);
    if (HOST_BOUND_REQUEST_METHODS.has(request.method)) {
      // The public contract makes these Host-bound inputs legal at T-M, but
      // this standalone plugin has no Host Broker. Reply conservatively
      // without storing ingress, session state, or activation.
      return methodNotFoundResponse(request.id);
    }
    if (request.method === 'host.lifecycle.ping') {
      const nonce = request.input.nonce;
      if (typeof nonce !== 'string') {
        throw new StandaloneProtocolError('classifier accepted ping without a nonce');
      }
      return { jsonrpc: '2.0', id: request.id, result: { nonce } };
    }
    if (request.method === 'host.messaging.deliver') {
      return dispatchMessage(request.id, request.input, options.delivery);
    }

    // No other unsupported method reaches this branch. Keep the assertion so
    // a future ready row cannot silently create standalone-shell behavior.
    throw new StandaloneProtocolError(`unsupported accepted method: ${request.method}`);
  };
}

const respondToInvalidJson: StdioFrameErrorHandler = error =>
  error.code === 'INVALID_JSON'
    ? {
        jsonrpc: '2.0',
        id: null,
        error: { code: PARSE_ERROR_CODE, message: PARSE_ERROR_MESSAGE },
      }
    : undefined;

function attachManifest(channel: StdioChannel, manifest: PluginManifest): StandaloneHost {
  return {
    manifest,
    send: frame => channel.send(frame),
    close: () => channel.close(),
    get failed(): boolean {
      return channel.failed;
    },
  };
}

/**
 * Starts the fail-closed plugin-side standalone shell.
 *
 * A manifest is validated by the published contract runtime before any stdio
 * listener is attached. Lifecycle rows execute locally. beta.8 handshake
 * requests reach the handler only to receive a conservative standard error;
 * no Broker behavior is present in this shell.
 */
export function startStandaloneHost(options: StandaloneHostOptions): StandaloneHost {
  const manifest = requireStdioManifest(options.manifest);

  const hasInput = options.input !== undefined;
  const hasOutput = options.output !== undefined;
  if (hasInput !== hasOutput) {
    throw new TypeError('standalone host requires both input and output streams');
  }

  const onFrame = createFrameHandler(options);
  const channel = hasInput
    ? createStdioChannel(options.input!, options.output!, {
        onFrame,
        onFrameError: respondToInvalidJson,
        onFatal: options.onFatal,
      })
    : startStdioRuntime({
        onFrame,
        onFrameError: respondToInvalidJson,
        onFatal: options.onFatal,
      });
  return attachManifest(channel, manifest);
}
