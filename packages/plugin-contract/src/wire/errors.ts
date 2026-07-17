/**
 * P-1a public wire-error envelope — the closed JSON-RPC 2.0 error surface
 * for every registry row (#1165 revision 3; maintainer R3 P1#1).
 *
 * JSON-RPC 2.0 §5.1 requires `code` AND `message`; `data` is optional in
 * the spec but contract-required here with a closed per-class schema.
 * `message` is an exact per-class `const` so `maxEncodedErrorBytes` and
 * the N/N+1 error-byte proofs are exact; human-readable diagnostics stay
 * in private Host logs and never reach the wire.
 */

export interface WireErrorClass {
  readonly name: string;
  /** Contract-reserved integer (range -32094..-32090). */
  readonly code: number;
  /** Exact `const` — the only legal wire value for this class. */
  readonly message: string;
  /** Anchor of the closed `error.data` schema for this class. */
  readonly dataSchema: string;
}

export const WIRE_ERROR_CLASSES: readonly WireErrorClass[] = [
  {
    name: 'HANDSHAKE_REJECTED',
    code: -32090,
    message: 'handshake rejected',
    dataSchema: 'HandshakeRejectedData', // { reason: HandshakeRejectReason } — closed 7-value enum
  },
  {
    name: 'DELIVERY_REJECTED',
    code: -32091,
    message: 'delivery rejected',
    dataSchema: 'DeliveryRejectedData', // { reason: UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL }
  },
  {
    name: 'DOMAIN_ERROR',
    code: -32092,
    message: 'domain error',
    dataSchema: 'DomainErrorData', // { code: MessagingErrorCode } — frozen 6-value enum
  },
  {
    name: 'DEADLINE_EXPIRED',
    code: -32093,
    message: 'deadline expired',
    dataSchema: 'DeadlineExpiredData', // {} exactly
  },
  {
    name: 'SNAPSHOT_UNAVAILABLE',
    code: -32094,
    message: 'snapshot unavailable',
    dataSchema: 'SnapshotUnavailableData', // { reason: OVERSIZED_ITEM | VIEW_EXPIRED | STORE_UNAVAILABLE }
  },
];

/** Contract-reserved integer range; new classes require a contract delta. */
export const WIRE_ERROR_CODE_RANGE = { min: -32094, max: -32090 } as const;

export const HANDSHAKE_REJECT_REASONS = [
  'MALFORMED_HELLO',
  'PACKAGE_MISMATCH',
  'CONTRACT_INCOMPATIBLE',
  'WIRE_INCOMPATIBLE',
  'AUTHORITY_VIOLATION',
  'DEADLINE_EXPIRED',
  'BINDING_REPLAY',
] as const;

export const DELIVERY_REJECT_REASONS = [
  'UNSUPPORTED_PAYLOAD',
  'NO_HANDLER',
  'PLUGIN_BUSY',
  'PLUGIN_INTERNAL',
] as const;

export const SNAPSHOT_UNAVAILABLE_REASONS = [
  'OVERSIZED_ITEM',
  'VIEW_EXPIRED',
  'STORE_UNAVAILABLE',
] as const;
