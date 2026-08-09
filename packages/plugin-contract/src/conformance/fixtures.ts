/**
 * Public, machine-readable wire-disposition safety vectors.
 *
 * These are contract data for conformance runners. They do not implement
 * Host activation or a handshake codec.
 */

export {
  DISPOSITION_FIXTURE_VECTORS,
  BETA8_HANDSHAKE_VECTOR_IDS,
  BETA9_EVENTS_PUBLISH_VECTOR_IDS,
  CLOSED_ERROR_ARM_NAMES,
  RESPONSE_CANDIDATE_CASES,
  NOTIFICATION_PARTITION_CASES,
} from '../wire/disposition-fixtures.js';

export type {
  ClosedErrorArmName,
  RequestSnapshot,
  InFlightRecord,
  FixturePreState,
  DispositionFixtureVector,
  PartitionCase,
} from '../wire/disposition-fixtures.js';
