/**
 * Public SDK entrypoint.
 *
 * This package intentionally exposes schema-neutral runtime primitives only.
 * Production RPC methods remain reserved in plugin-contract until their rows
 * become executable.
 */
export {
  StdioFrameError,
  StdioRuntimeFatalError,
  createStdioChannel,
  startStdioRuntime,
  type JsonObject,
  type StdioChannel,
  type StdioChannelOptions,
  type StdioFrameErrorCode,
  type StdioFrameHandler,
  type StdioRuntimeFatalReason,
  type StdioRuntimeFatalErrorOptions,
  type StdioRuntimeOptions,
} from './stdio-runtime.js';
