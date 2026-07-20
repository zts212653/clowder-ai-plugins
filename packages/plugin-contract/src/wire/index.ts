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
  BINDING_NONCE_MIN_LENGTH,
  BINDING_NONCE_MAX_LENGTH,
  BINDING_NONCE_MAX_ENCODED_BYTES,
  validatePackageDigest,
  validateBindingNonce,
} from './handshake.js';

export type {
  CandidateHello,
  SessionBinding,
  BrokerReadyParams,
} from './handshake.js';

// Grant snapshot
export {
  MAX_GRANT_ITEMS,
  validateEffectiveGrants,
} from './grants.js';

export type { GrantSnapshot } from './grants.js';

// Wire envelope family
export type {
  CallMeta,
  WireRequest,
  WireNotification,
  WireSuccessResponse,
  WireApplicationErrorResponse,
  WireStandardErrorResponse,
  WireErrorResponse,
  WireResponse,
} from './envelope.js';

// 12-row method registry
export {
  WIRE_METHOD_NAMES,
  WIRE_METHOD_REGISTRY,
  WIRE_METHOD_COUNT,
  PLUGIN_TO_HOST_METHODS,
  HOST_TO_PLUGIN_METHODS,
  NOTIFICATION_METHODS,
  CLOSED_LEAF_ROWS,
  RESERVED_LEAF_ROWS,
  getRegistryRow,
  isWireMethod,
  getMethodGrant,
} from './registry.js';

export type {
  MethodDirection,
  GrantRequirement,
  LeafClosureStatus,
  RegistryRow,
  WireMethodName,
} from './registry.js';

// Per-row input/result shapes
export type {
  // Closed rows
  SubscribeInput,
  SubscribeResult,
  MessagingAckRequest,
  MessagingAckResult,
  GrantsChangedInput,
  PingInput,
  PingResult,
  DrainInput,
  DrainResult,
  // Reserved row stubs
  HelloInput,
  HelloResult,
  ReadyInput,
  ReadyResult,
  SendInput,
  SendResult,
  AppendInput,
  AppendResult,
  ReadInput,
  ReadResult,
  SnapshotInput,
  SnapshotResult,
  DeliverInput,
  DeliverResult,
} from './row-shapes.js';

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
  // Row 11 bounds
  PING_NONCE_MIN_LENGTH,
  PING_NONCE_MAX_LENGTH,
  PING_NONCE_MAX_ENCODED_BYTES,
} from './row-shapes.js';
