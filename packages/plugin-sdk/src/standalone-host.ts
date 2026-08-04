import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import {
  PARSE_ERROR_CODE,
  PARSE_ERROR_MESSAGE,
  validateManifest,
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
import { classifyFrame, type InFlightEntry } from './wire-dispatch.js';

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
  /** Runs before the closed drain row is acknowledged with `result: null`. */
  readonly onDrain?: (input: { readonly deadlineUnixMs: number }) => void | Promise<void>;
  readonly onFatal?: (error: StdioRuntimeFatalError) => void;
}

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

    if (frame.value.method === 'host.grants.changed') {
      // The notification is closed and legal, but S2 has no grant-gated
      // behavior yet. Accepting it without fabricating a response preserves
      // its notification semantics while keeping authorization fail-closed.
      return undefined;
    }

    const request = requireRequest(frame.value);
    if (request.method === 'host.lifecycle.ping') {
      const nonce = request.input.nonce;
      if (typeof nonce !== 'string') {
        throw new StandaloneProtocolError('classifier accepted ping without a nonce');
      }
      return { jsonrpc: '2.0', id: request.id, result: { nonce } };
    }
    if (request.method === 'host.lifecycle.drain') {
      const deadlineUnixMs = request.input.deadlineUnixMs;
      if (typeof deadlineUnixMs !== 'number') {
        throw new StandaloneProtocolError('classifier accepted drain without a deadline');
      }
      await options.onDrain?.({ deadlineUnixMs });
      return { jsonrpc: '2.0', id: request.id, result: null };
    }
    // No RESERVED method reaches this branch: S1 rejects those rows before
    // dispatch. Keep the assertion so a future registry expansion cannot
    // silently create behavior in the standalone shell.
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
 * listener is attached. Only the already-CLOSED lifecycle rows are executed;
 * RESERVED handshake and messaging rows remain in S1's reject path.
 */
export function startStandaloneHost(options: StandaloneHostOptions): StandaloneHost {
  const manifest = requireValidManifest(options.manifest);

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
