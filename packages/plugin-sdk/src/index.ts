/**
 * Public SDK entrypoint.
 *
 * This package exposes:
 *   1. Schema-neutral NDJSON transport (stdio-runtime, S0/#12)
 *   2. Wire dispatch classifier (wire-dispatch, S1)
 *
 * Production RPC methods remain reserved in plugin-contract until their rows
 * become executable. The dispatch classifier gates all methods: CLOSED rows
 * validate input shapes, RESERVED rows fail-closed with T-G (input type is
 * `never` in v0 — no legal params exist).
 */
export {
  NdjsonFrameError,
  StdioRuntimeFatalError,
  createStdioChannel,
  startStdioRuntime,
  type StdioChannel,
  type StdioChannelOptions,
  type JsonObject,
  type StdioFrame,
  type StdioFrameErrorCode,
  type StdioFrameHandler,
  type StdioRuntimeFatalReason,
  type StdioRuntimeFatalErrorOptions,
  type StdioRuntimeOptions,
} from './stdio-runtime.js';

export {
  loadStandaloneManifest,
  ManifestStartupError,
  startStandaloneHost,
  type StandaloneHost,
  type StandaloneHostOptions,
} from './standalone-host.js';

export {
  classifyFrame,
  type DispatchResult,
  type InFlightEntry,
  type RequestSnapshot,
} from './wire-dispatch.js';
