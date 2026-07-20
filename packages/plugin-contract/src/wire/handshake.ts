/**
 * Handshake types — CandidateHello, SessionBinding, BrokerReadyParams.
 * Mechanized verbatim from #1165 frozen shape.
 *
 * Handshake flow:
 *   1. Plugin sends CandidateHello (candidate claims only, no grants/session).
 *   2. Host validates, mints instance/session ids, replies with SessionBinding.
 *   3. Plugin sends broker.ready with the bindingNonce to activate.
 *
 * CandidateHello and BrokerReadyParams REJECT any additional
 * identity/instance/grant/session fields (closed surface).
 */

import type { Capability } from '../generated/contract.generated.js';

// ---------------------------------------------------------------------------
// Package digest constants (CLOSED — H2)
// ---------------------------------------------------------------------------

/** Exact character length of a sha512 SRI digest. */
export const PACKAGE_DIGEST_LENGTH = 95 as const;

/**
 * Pattern for a valid sha512 SRI package digest.
 * 85 base64 chars + one of [AQgw] + '==' suffix.
 */
export const PACKAGE_DIGEST_PATTERN = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/;

/**
 * Compact-JSON encoded byte count for the digest string.
 * 95 chars (all ASCII) + 2 surrounding quotes = 97 bytes.
 */
export const PACKAGE_DIGEST_ENCODED_BYTES = 97 as const;

// ---------------------------------------------------------------------------
// Binding nonce bounds (CLOSED — H9)
// ---------------------------------------------------------------------------

/** Minimum code-point length for bindingNonce. */
export const BINDING_NONCE_MIN_LENGTH = 1 as const;

/** Maximum code-point length for bindingNonce. */
export const BINDING_NONCE_MAX_LENGTH = 512 as const;

/**
 * Maximum compact-JSON encoded bytes for bindingNonce.
 * Worst case: every code point is a 6-byte escape (\uXXXX) → 6 * 512 + 2 quotes.
 */
export const BINDING_NONCE_MAX_ENCODED_BYTES = 3074 as const;

// ---------------------------------------------------------------------------
// CandidateHello — plugin → Host, candidate claims only
// ---------------------------------------------------------------------------

/**
 * CandidateHello is sent by the plugin at connection open.
 * It carries only the plugin's candidate claims; no instance ids,
 * grant state, or session identifiers may appear.
 *
 * Additional identity/instance/grant/session fields are REJECTED.
 */
export interface CandidateHello {
  /** RESERVED (H1) — manifest pluginId, no maximum bound declared. */
  readonly pluginId: string;
  /** CLOSED (H2) — exactly 95 chars, sha512 SRI digest. */
  readonly packageDigest: string;
  /** RESERVED (H3) — SemVer contract version, no maximum bound declared. */
  readonly contractVersion: string;
  /** RESERVED (H4) — wire protocol version, not yet owner-declared. */
  readonly wireVersion: string;
}

// ---------------------------------------------------------------------------
// SessionBinding — Host → plugin, authoritative
// ---------------------------------------------------------------------------

/**
 * SessionBinding is the Host's authoritative response to CandidateHello.
 * It echoes the four hello fields, then adds Host-minted identifiers
 * and the effective grant snapshot.
 */
export interface SessionBinding {
  /** Echoed from CandidateHello. */
  readonly pluginId: string;
  /** Echoed from CandidateHello. */
  readonly packageDigest: string;
  /** Echoed from CandidateHello. */
  readonly contractVersion: string;
  /** Echoed from CandidateHello. */
  readonly wireVersion: string;
  /** RESERVED (H5) — Host-minted instance id, grammar pending. */
  readonly pluginInstanceId: string;
  /** RESERVED (H6) — Host-minted session id, grammar pending. */
  readonly brokerSessionId: string;
  /** CLOSED (H7) — WireUInt53(0, 9_007_199_254_740_991), monotonically increasing. */
  readonly grantRevision: number;
  /** CLOSED (H8) — unique Capability[], 0..17 items. */
  readonly effectiveGrants: readonly Capability[];
  /** CLOSED (H9) — opaque nonce, 1..512 code points. */
  readonly bindingNonce: string;
}

// ---------------------------------------------------------------------------
// BrokerReadyParams — broker.ready activation payload
// ---------------------------------------------------------------------------

/**
 * BrokerReadyParams is the params object for the broker.ready request.
 * It carries only bindingNonce for activation; it is NOT a resume carrier.
 *
 * Additional identity/instance/grant/session fields are REJECTED.
 */
export interface BrokerReadyParams {
  /** CLOSED (H9) — activation-only; echoes the nonce from SessionBinding. */
  readonly bindingNonce: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate a string as a conformant sha512 SRI package digest.
 * Checks exact length (95) and pattern match.
 */
export function validatePackageDigest(value: string): boolean {
  if (value.length !== PACKAGE_DIGEST_LENGTH) return false;
  return PACKAGE_DIGEST_PATTERN.test(value);
}

/**
 * Validate a string as a conformant binding nonce.
 * Checks code-point count is within [1, 512].
 *
 * Note: uses spread to count code points (not .length, which counts
 * UTF-16 code units and misreports surrogate pairs).
 */
export function validateBindingNonce(value: string): boolean {
  // Fast path: empty string
  if (value.length === 0) return false;
  // Fast path: if byte length <= max, code-point count <= max
  if (value.length <= BINDING_NONCE_MAX_LENGTH) return true;
  // Slow path: count actual code points for strings with surrogates
  const codePointCount = [...value].length;
  return codePointCount >= BINDING_NONCE_MIN_LENGTH && codePointCount <= BINDING_NONCE_MAX_LENGTH;
}
