/**
 * Conformance utilities — re-exported for programmatic use.
 *
 * The primary entry point is the runner CLI (runner.ts).
 * This module exports validation helpers that the host and SDK can use
 * to validate manifests and messages against the contract schemas.
 *
 * @packageDocumentation
 */

export { isValidDataClassStrategy } from '../types/data-class.js';

export { getCapabilityLayer } from '../types/capability.js';

export {
  executeBehaviorCase,
  type BehaviorAdapter,
  type BehaviorCaseReport,
  type BehaviorTarget,
  type BehaviorVerdict,
} from './behavior-executor.js';

export { MessagingLoopbackAdapter } from './messaging-loopback-adapter.js';

export {
  DISPOSITION_FIXTURE_VECTORS,
  BETA8_HANDSHAKE_VECTOR_IDS,
  BETA9_EVENTS_PUBLISH_VECTOR_IDS,
  BETA10_LIFECYCLE_VECTOR_IDS,
  CLOSED_ERROR_ARM_NAMES,
  RESPONSE_CANDIDATE_CASES,
  NOTIFICATION_PARTITION_CASES,
} from './fixtures.js';

export type {
  ClosedErrorArmName,
  RequestSnapshot,
  InFlightRecord,
  FixturePreState,
  DispositionFixtureVector,
  PartitionCase,
} from './fixtures.js';

export {
  HarnessChild,
  HarnessChildExitedError,
  HarnessCleanupError,
  HarnessFrameBacklogError,
  HarnessTimeoutError,
  MAX_HARNESS_QUEUED_FRAMES,
  MAX_NDJSON_FRAME_BYTES,
  MAX_TIMER_MS,
  NdjsonFrameDecoder,
  NdjsonFrameError,
  encodeNdjsonFrame,
  runDualTransportOracle,
  runHarnessCase,
  spawnHarnessChild,
  type DecodedNdjsonFrame,
  type DualTransportOracleCase,
  type DualTransportOracleReport,
  type HarnessChildExit,
  type HarnessReceiveOptions,
  type HarnessWireShape,
  type JsonObject,
  type NdjsonFrameErrorCode,
  type OracleTransport,
  type RunHarnessCaseOptions,
  type SpawnHarnessChildOptions,
  type TransportTranscript,
} from './stdio-harness/index.js';

export {
  DATA_CLASS_ALLOWED_STRATEGIES,
  CAPABILITY_TABLE,
  L0_CAPABILITIES,
  L1_CAPABILITIES,
  L2_CAPABILITIES,
} from '../generated/contract.generated.js';
