/**
 * Wire protocol module barrel export.
 *
 * Re-exports all wire-protocol types, constants, validators, and registry
 * entries mechanized from the #1165 frozen shape (rev11).
 *
 * This module defines nothing new — it is a pure re-export surface.
 */

// Framing constants
export {
  MAX_FRAME_BYTES,
  WIRE_VERSION,
  CONTRACT_VERSION,
  JSONRPC_VERSION,
  MAX_ELEMENT_PAYLOAD_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  MAX_ELEMENTS_PER_OPERATION,
  MAX_ELEMENTS_PER_MESSAGE,
  MAX_WHISPER_TARGETS,
} from './constants.js';

// RequestId — branded type + validators
export type { RequestId } from './request-id.js';
export {
  REQUEST_ID_PATTERN,
  REQUEST_ID_MIN_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_MIN_ENCODED_BYTES,
  REQUEST_ID_MAX_ENCODED_BYTES,
  validateRequestId,
  isRequestIdShaped,
} from './request-id.js';

// WireUInt53 — numeric profile
export {
  WIRE_UINT53_MAX,
  WIRE_UINT53_RAW_PATTERN,
  WIRE_UINT53_MAX_RAW_LENGTH,
  isWireUInt53,
  isCanonicalUInt53Token,
} from './wire-uint53.js';

// Error codes, messages, reason taxonomies, and error variant types
export {
  // Application error codes
  HANDSHAKE_REJECTED_CODE,
  DELIVERY_REJECTED_CODE,
  DOMAIN_ERROR_CODE,
  DEADLINE_EXPIRED_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  // Application error messages
  HANDSHAKE_REJECTED_MESSAGE,
  DELIVERY_REJECTED_MESSAGE,
  DOMAIN_ERROR_MESSAGE,
  DEADLINE_EXPIRED_MESSAGE,
  SNAPSHOT_UNAVAILABLE_MESSAGE,
  // Standard error codes
  PARSE_ERROR_CODE,
  INVALID_REQUEST_CODE,
  METHOD_NOT_FOUND_CODE,
  INVALID_PARAMS_CODE,
  INTERNAL_ERROR_CODE,
  // Standard error messages
  PARSE_ERROR_MESSAGE,
  INVALID_REQUEST_MESSAGE,
  METHOD_NOT_FOUND_MESSAGE,
  INVALID_PARAMS_MESSAGE,
  INTERNAL_ERROR_MESSAGE,
  // Code-to-message mapping
  ERROR_CODE_TO_MESSAGE,
  // Reject-reason taxonomies
  HANDSHAKE_REJECT_REASONS,
  DELIVERY_REJECT_REASONS,
  SNAPSHOT_UNAVAILABLE_REASONS,
  // Collected code arrays
  APPLICATION_ERROR_CODES,
  STANDARD_ERROR_CODES,
  ALL_ERROR_CODES,
} from './errors.js';

export type {
  HandshakeRejectReason,
  DeliveryRejectReason,
  SnapshotUnavailableReason,
  MessagingErrorCode,
  // Application error body types
  HandshakeRejectedError,
  DeliveryRejectedError,
  DomainError,
  DeadlineExpiredError,
  SnapshotUnavailableError,
  ApplicationWireError,
  // Standard error body types
  ParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  StandardWireError,
  // Exhaustive union
  WireError,
} from './errors.js';

// Pre-dispatch disposition table
export {
  DISPOSITION_CLASSES,
  DISPOSITION_TABLE,
  CLOSE_CLASSES,
  RESPOND_CLASSES,
  ACCEPT_CLASSES,
} from './disposition.js';

// Machine-readable disposition/conformance vectors
export {
  DISPOSITION_FIXTURE_VECTORS,
  BETA8_HANDSHAKE_VECTOR_IDS,
  BETA9_EVENTS_PUBLISH_VECTOR_IDS,
  BETA10_LIFECYCLE_VECTOR_IDS,
  CLOSED_ERROR_ARM_NAMES,
  RESPONSE_CANDIDATE_CASES,
  NOTIFICATION_PARTITION_CASES,
} from './disposition-fixtures.js';

export type {
  ClosedErrorArmName,
  RequestSnapshot,
  InFlightRecord,
  FixturePreState,
  DispositionFixtureVector,
  PartitionCase,
} from './disposition-fixtures.js';

export type {
  DispositionClass,
  DispositionOutcome,
  DispositionEntry,
} from './disposition.js';

// Handshake types + validators
export {
  PACKAGE_DIGEST_LENGTH,
  PACKAGE_DIGEST_PATTERN,
  PACKAGE_DIGEST_ENCODED_BYTES,
  PLUGIN_ID_MIN_LENGTH,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_MAX_ENCODED_BYTES,
  HANDSHAKE_VERSION_MAX_LENGTH,
  HANDSHAKE_VERSION_MAX_ENCODED_BYTES,
  HANDSHAKE_SEMVER_PATTERN,
  HOST_IDENTIFIER_MIN_LENGTH,
  HOST_IDENTIFIER_MAX_LENGTH,
  HOST_IDENTIFIER_MAX_ENCODED_BYTES,
  BINDING_NONCE_MIN_LENGTH,
  BINDING_NONCE_MAX_LENGTH,
  BINDING_NONCE_MAX_ENCODED_BYTES,
  validatePackageDigest,
  validatePluginId,
  validateContractVersion,
  validateWireVersion,
  validatePluginInstanceId,
  validateBrokerSessionId,
  validateBindingNonce,
  hasHandshakeAuthorityInjection,
  validateCandidateHello,
  validateSessionBinding,
  validateBrokerReadyParams,
} from './handshake.js';

export type {
  CandidateHello,
  SessionBinding,
  BrokerReadyParams,
} from './handshake.js';

// Derived beta.8 handshake byte-bound evidence
export {
  HANDSHAKE_BYTE_PROOF_ENCODING_FAMILIES,
  BROKER_HELLO_REQUEST_BYTE_PROOF,
  BROKER_HELLO_RESULT_BYTE_PROOF,
  BROKER_READY_REQUEST_BYTE_PROOF,
  HANDSHAKE_REJECTED_ERROR_BYTE_PROOF,
  BROKER_HELLO_MAX_ENCODED_REQUEST_BYTES,
  BROKER_HELLO_MAX_ENCODED_RESULT_BYTES,
  BROKER_HELLO_MAX_ENCODED_ERROR_BYTES,
  BROKER_READY_MAX_ENCODED_REQUEST_BYTES,
  BROKER_READY_MAX_ENCODED_RESULT_BYTES,
  BROKER_READY_MAX_ENCODED_ERROR_BYTES,
  HANDSHAKE_ROW_ENCODED_BYTE_BOUNDS,
} from './handshake-byte-bounds.js';

// Derived beta.9 C-2 signal-publish byte-bound evidence
export {
  EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES,
  SIGNAL_TYPE_MAX_LENGTH,
  SIGNAL_EVENT_ID_MAX_LENGTH,
  SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  SIGNAL_OCCURRED_AT_MAX_LENGTH,
  SIGNAL_SOURCE_HANDLE_MAX_LENGTH,
  EVENTS_PUBLISH_REQUEST_BYTE_PROOF,
  EVENTS_PUBLISH_RESULT_BYTE_PROOF,
  EVENTS_PUBLISH_ERROR_BYTE_PROOF,
  EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS,
} from './signal-byte-bounds.js';

// Derived beta.10 M0-B lifecycle byte-bound evidence
export {
  LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES,
  HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF,
  HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF,
  HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_ERROR_BYTE_PROOF,
  LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS,
} from './lifecycle-byte-bounds.js';

export type {
  LifecycleByteProofEncodingFamily,
  LifecycleNPlusOneByteProof,
  LifecycleEncodedByteProofCase,
  LifecycleEncodedByteProof,
  LifecycleRequestRowEncodedByteBounds,
  LifecycleNotificationRowEncodedByteBounds,
} from './lifecycle-byte-bounds.js';

// Derived beta.11 M0-C messaging byte-bound evidence
export {
  MESSAGING_BYTE_PROOF_ENCODING_FAMILIES,
  MESSAGING_REQUEST_BYTE_PROOFS,
  MESSAGING_RESULT_BYTE_PROOFS,
  MESSAGING_ERROR_BYTE_PROOFS,
  MESSAGING_ROW_ENCODED_BYTE_BOUNDS,
} from './messaging-byte-bounds.js';

export type {
  MessagingByteProofEncodingFamily,
  MessagingByteProofBasis,
  MessagingNPlusOneByteProof,
  MessagingEncodedByteProofCase,
  MessagingEncodedByteProof,
  MessagingRowEncodedByteBounds,
} from './messaging-byte-bounds.js';

export type {
  EventsPublishByteProofEncodingFamily,
  EventsPublishNPlusOneWitness,
  EventsPublishEncodedByteProofCase,
  EventsPublishEncodedByteProof,
  EventsPublishRowEncodedByteBounds,
} from './signal-byte-bounds.js';

export type {
  HandshakeByteProofEncodingFamily,
  HandshakeNPlusOneByteProof,
  HandshakeEncodedByteProofCase,
  HandshakeEncodedByteProof,
  HandshakeRowEncodedByteBounds,
} from './handshake-byte-bounds.js';

// Grant snapshot
export {
  MAX_GRANT_ITEMS,
  validateEffectiveGrants,
  VALID_CAPABILITIES,
} from './grants.js';

export type { GrantSnapshot } from './grants.js';

// Wire envelope family — closed public surface (Q1 ruling)
//
// Generic building blocks (WireRequest, WireNotification,
// WireApplicationErrorResponse, WireStandardErrorResponse) are intentionally
// NOT re-exported. They are internal constructors in envelope.ts.
//
// Rationale: #1165 mandates closed enumerations. The public API exposes only
// the 11 concrete error envelopes, their closed union, and the closed
// success/response types. Zero external consumers exist for the generics
// (verified via `rg`). See Q1 architecture ruling by Fable.
export type {
  CallMeta,
  WireSuccessResponse,
  // Concrete error envelopes (11 variants)
  HandshakeRejectedEnvelope,
  DeliveryRejectedEnvelope,
  DomainErrorEnvelope,
  DeadlineExpiredEnvelope,
  SnapshotUnavailableEnvelope,
  ParseErrorEnvelope,
  InvalidRequestNullIdEnvelope,
  InvalidRequestValidIdEnvelope,
  MethodNotFoundEnvelope,
  InvalidParamsEnvelope,
  InternalErrorEnvelope,
  ClosedWireErrorResponse,
  WireErrorResponse,
  WireResponse,
} from './envelope.js';

// 13-row method registry (frozen original 12 + C-2 publish)
export {
  WIRE_METHOD_NAMES,
  WIRE_METHOD_REGISTRY,
  WIRE_METHOD_COUNT,
  PLUGIN_TO_HOST_METHODS,
  HOST_TO_PLUGIN_METHODS,
  NOTIFICATION_METHODS,
  CLOSED_LEAF_ROWS,
  RESERVED_LEAF_ROWS,
  READY_ROWS,
  getRegistryRow,
  isWireMethod,
  getMethodGrant,
} from './registry.js';

export type {
  MethodDirection,
  GrantRequirement,
  LeafClosureStatus,
  RegistryRow,
  ReadyRegistryRow,
  UnreadyRegistryRow,
  WireMethodRegistry,
  WireMethodName,
} from './registry.js';

// Per-row input/result shapes
export type {
  // Closed rows
  HelloInput,
  HelloResult,
  ReadyInput,
  ReadyResult,
  SubscribeInput,
  SubscribeResult,
  MessagingAckRequest,
  MessagingAckResult,
  GrantsChangedInput,
  PingInput,
  PingResult,
  DrainInput,
  DrainResult,
  SendInput,
  SendResult,
  AppendInput,
  AppendResult,
  SubscriptionReadPageRequest,
  SubscriptionNormalPageResponse,
  SubscriptionEmptyPageResponse,
  SubscriptionStalePageResponse,
  BoundedSubscriptionReadPageResponse,
  ReadInput,
  ReadResult,
  SnapshotPageRequest,
  SnapshotIntermediatePageResponse,
  SnapshotFinalPageResponse,
  SnapshotPageResponse,
  SnapshotInput,
  SnapshotResult,
  HostMessagingDeliverRequest,
  HostMessagingDeliverResult,
  DeliverInput,
  DeliverResult,
} from './row-shapes.js';

export type {
  EventsPublishInput,
  EventsPublishResult,
} from '../generated/contract.generated.js';

export {
  // Row 5 bounds
  SUBSCRIBE_HANDLE_MIN_LENGTH,
  SUBSCRIBE_HANDLE_MAX_LENGTH,
  SUBSCRIBE_HANDLE_MAX_ENCODED_BYTES,
  SUBSCRIBE_SUBSCRIPTION_ID_MIN_LENGTH,
  SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH,
  SUBSCRIBE_SUBSCRIPTION_ID_MAX_ENCODED_BYTES,
  // Row 7 bounds
  ACK_SUBSCRIPTION_ID_MIN_LENGTH,
  ACK_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_SUBSCRIPTION_ID_MAX_ENCODED_BYTES,
  ACK_TOKEN_MIN_LENGTH,
  ACK_TOKEN_MAX_LENGTH,
  ACK_TOKEN_MAX_ENCODED_BYTES,
  // Row 6 bounds
  READ_SUBSCRIPTION_ID_MIN_LENGTH,
  READ_SUBSCRIPTION_ID_MAX_LENGTH,
  READ_LIMIT_MIN,
  READ_LIMIT_MAX,
  READ_ACK_TOKEN_MIN_LENGTH,
  READ_ACK_TOKEN_MAX_LENGTH,
  // Row 8 bounds
  SNAPSHOT_SUBSCRIPTION_ID_MIN_LENGTH,
  SNAPSHOT_SUBSCRIPTION_ID_MAX_LENGTH,
  SNAPSHOT_MAX_ITEMS_MIN,
  SNAPSHOT_MAX_ITEMS_MAX,
  SNAPSHOT_PAGE_TOKEN_MIN_LENGTH,
  SNAPSHOT_PAGE_TOKEN_MAX_LENGTH,
  SNAPSHOT_ACK_TOKEN_MIN_LENGTH,
  SNAPSHOT_ACK_TOKEN_MAX_LENGTH,
  // Row 9 bounds
  DELIVER_DELIVERY_ID_MIN_LENGTH,
  DELIVER_DELIVERY_ID_MAX_LENGTH,
  // Row 11 bounds
  PING_NONCE_MIN_LENGTH,
  PING_NONCE_MAX_LENGTH,
  PING_NONCE_MAX_ENCODED_BYTES,
} from './row-shapes.js';
