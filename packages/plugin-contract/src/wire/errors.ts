/**
 * Wire-protocol error types — application and standard variants.
 * Mechanized verbatim from the #1165 frozen shape.
 *
 * Application errors (R2 co-signed):
 *   HANDSHAKE_REJECTED (-32090), DELIVERY_REJECTED (-32091),
 *   DOMAIN_ERROR (-32092), DEADLINE_EXPIRED (-32093),
 *   SNAPSHOT_UNAVAILABLE (-32094).
 *
 * Standard JSON-RPC errors (R29):
 *   Parse error (-32700), Invalid Request (-32600, two id arms),
 *   Method not found (-32601), Invalid params (-32602),
 *   Internal error (-32603).
 *
 * Total: 5 application classes + 5 standard error body types = 10 error
 * body types. Invalid Request has two id arms at the ENVELOPE level
 * (valid-id echo vs null), but the error body is identical — yielding
 * 11 closed envelope-level variants for byte-proof purposes.
 *
 * This module defines nothing new — every value traces to a frozen
 * #1165 revision.
 */

import type { MessagingErrorCode } from '../generated/contract.generated.js';

// ---------------------------------------------------------------------------
// Application error codes (R2)
// ---------------------------------------------------------------------------

/** Handshake rejected by host or plugin. */
export const HANDSHAKE_REJECTED_CODE = -32090 as const;

/** Delivery rejected — message could not be dispatched to handler. */
export const DELIVERY_REJECTED_CODE = -32091 as const;

/** Domain-level error surfaced through the messaging layer. */
export const DOMAIN_ERROR_CODE = -32092 as const;

/** Operation exceeded its time budget. */
export const DEADLINE_EXPIRED_CODE = -32093 as const;

/** Requested snapshot state is not available. */
export const SNAPSHOT_UNAVAILABLE_CODE = -32094 as const;

// ---------------------------------------------------------------------------
// Application error messages (R2, exact const strings)
// ---------------------------------------------------------------------------

/** Canonical message for HANDSHAKE_REJECTED. */
export const HANDSHAKE_REJECTED_MESSAGE = 'handshake rejected' as const;

/** Canonical message for DELIVERY_REJECTED. */
export const DELIVERY_REJECTED_MESSAGE = 'delivery rejected' as const;

/** Canonical message for DOMAIN_ERROR. */
export const DOMAIN_ERROR_MESSAGE = 'domain error' as const;

/** Canonical message for DEADLINE_EXPIRED. */
export const DEADLINE_EXPIRED_MESSAGE = 'deadline expired' as const;

/** Canonical message for SNAPSHOT_UNAVAILABLE. */
export const SNAPSHOT_UNAVAILABLE_MESSAGE = 'snapshot unavailable' as const;

// ---------------------------------------------------------------------------
// Standard JSON-RPC error codes (R29)
// ---------------------------------------------------------------------------

/** JSON could not be parsed. */
export const PARSE_ERROR_CODE = -32700 as const;

/** The JSON sent is not a valid Request object. */
export const INVALID_REQUEST_CODE = -32600 as const;

/** The method does not exist or is not available. */
export const METHOD_NOT_FOUND_CODE = -32601 as const;

/** Invalid method parameter(s). */
export const INVALID_PARAMS_CODE = -32602 as const;

/** Internal JSON-RPC error. */
export const INTERNAL_ERROR_CODE = -32603 as const;

// ---------------------------------------------------------------------------
// Standard JSON-RPC error messages (R29, exact const strings)
// ---------------------------------------------------------------------------

/** Canonical message for Parse error. */
export const PARSE_ERROR_MESSAGE = 'Parse error' as const;

/** Canonical message for Invalid Request. */
export const INVALID_REQUEST_MESSAGE = 'Invalid Request' as const;

/** Canonical message for Method not found. */
export const METHOD_NOT_FOUND_MESSAGE = 'Method not found' as const;

/** Canonical message for Invalid params. */
export const INVALID_PARAMS_MESSAGE = 'Invalid params' as const;

/** Canonical message for Internal error. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error' as const;

// ---------------------------------------------------------------------------
// Code-to-message mapping
// ---------------------------------------------------------------------------

/**
 * Maps every wire error code to its canonical error message constant.
 * Covers all 10 distinct codes (Invalid Request's two id-arms share one code).
 */
export const ERROR_CODE_TO_MESSAGE = {
  [HANDSHAKE_REJECTED_CODE]: HANDSHAKE_REJECTED_MESSAGE,
  [DELIVERY_REJECTED_CODE]: DELIVERY_REJECTED_MESSAGE,
  [DOMAIN_ERROR_CODE]: DOMAIN_ERROR_MESSAGE,
  [DEADLINE_EXPIRED_CODE]: DEADLINE_EXPIRED_MESSAGE,
  [SNAPSHOT_UNAVAILABLE_CODE]: SNAPSHOT_UNAVAILABLE_MESSAGE,
  [PARSE_ERROR_CODE]: PARSE_ERROR_MESSAGE,
  [INVALID_REQUEST_CODE]: INVALID_REQUEST_MESSAGE,
  [METHOD_NOT_FOUND_CODE]: METHOD_NOT_FOUND_MESSAGE,
  [INVALID_PARAMS_CODE]: INVALID_PARAMS_MESSAGE,
  [INTERNAL_ERROR_CODE]: INTERNAL_ERROR_MESSAGE,
} as const;

// ---------------------------------------------------------------------------
// Reject-reason taxonomies (closed enums, R2)
// ---------------------------------------------------------------------------

/**
 * Closed set of reasons a handshake may be rejected.
 * Mechanized from #1165 R2.
 */
export const HANDSHAKE_REJECT_REASONS = [
  'MALFORMED_HELLO',
  'PACKAGE_MISMATCH',
  'CONTRACT_INCOMPATIBLE',
  'WIRE_INCOMPATIBLE',
  'AUTHORITY_VIOLATION',
  'DEADLINE_EXPIRED',
  'BINDING_REPLAY',
] as const;

/** Union of all handshake-rejection reasons. */
export type HandshakeRejectReason = (typeof HANDSHAKE_REJECT_REASONS)[number];

/**
 * Closed set of reasons a delivery may be rejected.
 * Mechanized from #1165 R2.
 */
export const DELIVERY_REJECT_REASONS = [
  'UNSUPPORTED_PAYLOAD',
  'NO_HANDLER',
  'PLUGIN_BUSY',
  'PLUGIN_INTERNAL',
] as const;

/** Union of all delivery-rejection reasons. */
export type DeliveryRejectReason = (typeof DELIVERY_REJECT_REASONS)[number];

/**
 * Closed set of reasons a snapshot may be unavailable.
 * Mechanized from #1165 R2.
 */
export const SNAPSHOT_UNAVAILABLE_REASONS = [
  'OVERSIZED_ITEM',
  'VIEW_EXPIRED',
  'STORE_UNAVAILABLE',
] as const;

/** Union of all snapshot-unavailability reasons. */
export type SnapshotUnavailableReason = (typeof SNAPSHOT_UNAVAILABLE_REASONS)[number];

// Re-export MessagingErrorCode for downstream convenience.
export type { MessagingErrorCode } from '../generated/contract.generated.js';

// ---------------------------------------------------------------------------
// Application wire-error variant types (R2)
// ---------------------------------------------------------------------------

/**
 * HANDSHAKE_REJECTED (-32090).
 * Sent when the handshake is refused for a well-typed reason.
 */
export type HandshakeRejectedError = {
  readonly code: typeof HANDSHAKE_REJECTED_CODE;
  readonly message: typeof HANDSHAKE_REJECTED_MESSAGE;
  readonly data: { readonly reason: HandshakeRejectReason };
};

/**
 * DELIVERY_REJECTED (-32091).
 * Sent when a dispatched message cannot be accepted by the plugin.
 */
export type DeliveryRejectedError = {
  readonly code: typeof DELIVERY_REJECTED_CODE;
  readonly message: typeof DELIVERY_REJECTED_MESSAGE;
  readonly data: { readonly reason: DeliveryRejectReason };
};

/**
 * DOMAIN_ERROR (-32092).
 * Domain-level failure surfaced through the messaging error taxonomy.
 */
export type DomainError = {
  readonly code: typeof DOMAIN_ERROR_CODE;
  readonly message: typeof DOMAIN_ERROR_MESSAGE;
  readonly data: { readonly code: MessagingErrorCode };
};

/**
 * DEADLINE_EXPIRED (-32093).
 * The operation's time budget was exhausted. Data is an empty object.
 */
export type DeadlineExpiredError = {
  readonly code: typeof DEADLINE_EXPIRED_CODE;
  readonly message: typeof DEADLINE_EXPIRED_MESSAGE;
  readonly data: Record<string, never>;
};

/**
 * SNAPSHOT_UNAVAILABLE (-32094).
 * Requested snapshot state cannot be provided.
 */
export type SnapshotUnavailableError = {
  readonly code: typeof SNAPSHOT_UNAVAILABLE_CODE;
  readonly message: typeof SNAPSHOT_UNAVAILABLE_MESSAGE;
  readonly data: { readonly reason: SnapshotUnavailableReason };
};

/** Union of all 5 application wire errors. */
export type ApplicationWireError =
  | HandshakeRejectedError
  | DeliveryRejectedError
  | DomainError
  | DeadlineExpiredError
  | SnapshotUnavailableError;

// ---------------------------------------------------------------------------
// Standard JSON-RPC wire-error variant types (R29)
// ---------------------------------------------------------------------------

/**
 * Parse error (-32700).
 * JSON could not be parsed. id is always null, no data field.
 */
export type ParseError = {
  readonly code: typeof PARSE_ERROR_CODE;
  readonly message: typeof PARSE_ERROR_MESSAGE;
};

/**
 * Invalid Request (-32600).
 * The JSON sent is not a valid Request object.
 *
 * Two id arms at the envelope level (WireErrorResponse):
 *   - valid-id arm: envelope id = byte-equal RequestId echo
 *   - no-id arm: envelope id = null (true detection failure)
 * The error body itself is identical for both arms.
 */
export type InvalidRequestError = {
  readonly code: typeof INVALID_REQUEST_CODE;
  readonly message: typeof INVALID_REQUEST_MESSAGE;
};

/**
 * Method not found (-32601).
 * The requested method does not exist.
 * Envelope id = byte-equal RequestId echo.
 */
export type MethodNotFoundError = {
  readonly code: typeof METHOD_NOT_FOUND_CODE;
  readonly message: typeof METHOD_NOT_FOUND_MESSAGE;
};

/**
 * Invalid params (-32602).
 * Method parameters are invalid.
 * Envelope id = byte-equal RequestId echo.
 */
export type InvalidParamsError = {
  readonly code: typeof INVALID_PARAMS_CODE;
  readonly message: typeof INVALID_PARAMS_MESSAGE;
};

/**
 * Internal error (-32603).
 * Internal JSON-RPC processing failure.
 * Envelope id = byte-equal RequestId echo.
 */
export type InternalError = {
  readonly code: typeof INTERNAL_ERROR_CODE;
  readonly message: typeof INTERNAL_ERROR_MESSAGE;
};

/** Union of all 5 standard wire-error body types. */
export type StandardWireError =
  | ParseError
  | InvalidRequestError
  | MethodNotFoundError
  | InvalidParamsError
  | InternalError;

// ---------------------------------------------------------------------------
// Exhaustive closed union (11 variants total)
// ---------------------------------------------------------------------------

/**
 * The complete closed union of all wire-protocol error variants.
 * 5 application + 6 standard = 11 variants.
 *
 * This type is exhaustive: any wire error returned on the protocol
 * MUST be narrowable to one of these 11 shapes. Adding a variant
 * requires a contract revision.
 */
export type WireError = ApplicationWireError | StandardWireError;

// ---------------------------------------------------------------------------
// All error codes collected for iteration
// ---------------------------------------------------------------------------

/** All application error codes. */
export const APPLICATION_ERROR_CODES = [
  HANDSHAKE_REJECTED_CODE,
  DELIVERY_REJECTED_CODE,
  DOMAIN_ERROR_CODE,
  DEADLINE_EXPIRED_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
] as const;

/** All standard JSON-RPC error codes. */
export const STANDARD_ERROR_CODES = [
  PARSE_ERROR_CODE,
  INVALID_REQUEST_CODE,
  METHOD_NOT_FOUND_CODE,
  INVALID_PARAMS_CODE,
  INTERNAL_ERROR_CODE,
] as const;

/** All wire error codes (application + standard). */
export const ALL_ERROR_CODES = [
  ...APPLICATION_ERROR_CODES,
  ...STANDARD_ERROR_CODES,
] as const;
