export {
  HarnessChild,
  HarnessChildExitedError,
  HarnessCleanupError,
  HarnessFrameBacklogError,
  HarnessTimeoutError,
  MAX_HARNESS_QUEUED_FRAMES,
  runHarnessCase,
  spawnHarnessChild,
  type HarnessChildExit,
  type HarnessReceiveOptions,
  type RunHarnessCaseOptions,
  type SpawnHarnessChildOptions,
} from './child-process-harness.js';

export {
  runDualTransportOracle,
  type DualTransportOracleCase,
  type DualTransportOracleReport,
  type OracleTransport,
  type TransportTranscript,
} from './dual-transport-oracle.js';

export {
  MAX_NDJSON_FRAME_BYTES,
  NdjsonFrameDecoder,
  NdjsonFrameError,
  encodeNdjsonFrame,
  type DecodedNdjsonFrame,
  type JsonObject,
  type NdjsonFrameErrorCode,
} from './ndjson-frame.js';

export type { HarnessWireShape } from './wire-shape.js';
