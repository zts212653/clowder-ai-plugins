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
import { validateEffectiveGrants } from './grants.js';
import { isWireUInt53 } from './wire-uint53.js';

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
// H1/H3/H4/H5/H6 closure bounds
// ---------------------------------------------------------------------------

/** H1 wire pluginId minimum length in Unicode code points. */
export const PLUGIN_ID_MIN_LENGTH = 1 as const;

/** H1 wire pluginId maximum length in Unicode code points. */
export const PLUGIN_ID_MAX_LENGTH = 256 as const;

/** Worst compact-JSON encoded bytes for H1 pluginId. */
export const PLUGIN_ID_MAX_ENCODED_BYTES = 1538 as const;

/** Shared H3/H4 SemVer maximum length (the grammar is ASCII-only). */
export const HANDSHAKE_VERSION_MAX_LENGTH = 256 as const;

/** Worst compact-JSON encoded bytes for H3/H4 version strings. */
export const HANDSHAKE_VERSION_MAX_ENCODED_BYTES = 258 as const;

/** Exact SemVer 2.0.0 grammar copied from manifest.schema.json $defs.SemVer. */
export const HANDSHAKE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** H5/H6 opaque Host-minted identifier minimum length in code points. */
export const HOST_IDENTIFIER_MIN_LENGTH = 1 as const;

/** H5/H6 opaque Host-minted identifier maximum length in code points. */
export const HOST_IDENTIFIER_MAX_LENGTH = 512 as const;

/** Worst compact-JSON encoded bytes for either opaque Host identifier. */
export const HOST_IDENTIFIER_MAX_ENCODED_BYTES = 3074 as const;

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
  /** CLOSED (H1) — manifest pluginId, 1..256 Unicode code points. */
  readonly pluginId: string;
  /** CLOSED (H2) — exactly 95 chars, sha512 SRI digest. */
  readonly packageDigest: string;
  /** CLOSED (H3) — SemVer contract version, at most 256 ASCII characters. */
  readonly contractVersion: string;
  /** CLOSED (H4) — SemVer wire protocol version, at most 256 ASCII characters. */
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
  /** CLOSED (H5) — Host-minted instance id, 1..512 Unicode code points. */
  readonly pluginInstanceId: string;
  /** CLOSED (H6) — Host-minted session id, 1..512 Unicode code points. */
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
export function validatePackageDigest(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== PACKAGE_DIGEST_LENGTH) return false;
  return PACKAGE_DIGEST_PATTERN.test(value);
}

/** Test a string's code-point length using the established H9 convention. */
function hasCodePointLength(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length <= max) return value.length >= min;
  const codePointCount = [...value].length;
  return codePointCount >= min && codePointCount <= max;
}

/** Validate H1's bounded wire representation without narrowing manifest syntax. */
export function validatePluginId(value: unknown): value is string {
  return hasCodePointLength(value, PLUGIN_ID_MIN_LENGTH, PLUGIN_ID_MAX_LENGTH);
}

/** Validate an exact, bounded SemVer candidate used by H3 and H4. */
function validateHandshakeVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= HANDSHAKE_VERSION_MAX_LENGTH &&
    HANDSHAKE_SEMVER_PATTERN.test(value)
  );
}

/** Validate H3 contractVersion. Ranges and non-SemVer values are rejected. */
export function validateContractVersion(value: unknown): value is string {
  return validateHandshakeVersion(value);
}

/** Validate H4 wireVersion. Compatibility negotiation is Host policy, not syntax. */
export function validateWireVersion(value: unknown): value is string {
  return validateHandshakeVersion(value);
}

/** Validate H5 pluginInstanceId as an opaque Host-minted bounded value. */
export function validatePluginInstanceId(value: unknown): value is string {
  return hasCodePointLength(value, HOST_IDENTIFIER_MIN_LENGTH, HOST_IDENTIFIER_MAX_LENGTH);
}

/** Validate H6 brokerSessionId as an opaque Host-minted bounded value. */
export function validateBrokerSessionId(value: unknown): value is string {
  return hasCodePointLength(value, HOST_IDENTIFIER_MIN_LENGTH, HOST_IDENTIFIER_MAX_LENGTH);
}

/**
 * Validate a string as a conformant binding nonce.
 * Checks code-point count is within [1, 512].
 *
 * Note: uses spread to count code points (not .length, which counts
 * UTF-16 code units and misreports surrogate pairs).
 */
export function validateBindingNonce(value: unknown): value is string {
  return hasCodePointLength(value, BINDING_NONCE_MIN_LENGTH, BINDING_NONCE_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// Closed handshake object validators
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

const CANDIDATE_HELLO_KEYS = new Set([
  'pluginId', 'packageDigest', 'contractVersion', 'wireVersion',
]);
const SESSION_BINDING_KEYS = new Set([
  'pluginId', 'packageDigest', 'contractVersion', 'wireVersion',
  'pluginInstanceId', 'brokerSessionId', 'grantRevision', 'effectiveGrants',
  'bindingNonce',
]);
const BROKER_READY_PARAMS_KEYS = new Set(['bindingNonce']);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
}

/**
 * Validate the closed plugin-to-Host CandidateHello object. It deliberately
 * validates only grammar: the Host decides whether the candidate is allowed.
 */
export function validateCandidateHello(value: unknown): value is CandidateHello {
  return (
    isRecord(value) &&
    hasExactKeys(value, CANDIDATE_HELLO_KEYS) &&
    validatePluginId(value.pluginId) &&
    validatePackageDigest(value.packageDigest) &&
    validateContractVersion(value.contractVersion) &&
    validateWireVersion(value.wireVersion)
  );
}

/**
 * Validate the closed Host-to-plugin SessionBinding object. Candidate echo
 * equality and nonce-use state are peer protocol checks, not schema grammar.
 */
export function validateSessionBinding(value: unknown): value is SessionBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, SESSION_BINDING_KEYS) &&
    validatePluginId(value.pluginId) &&
    validatePackageDigest(value.packageDigest) &&
    validateContractVersion(value.contractVersion) &&
    validateWireVersion(value.wireVersion) &&
    validatePluginInstanceId(value.pluginInstanceId) &&
    validateBrokerSessionId(value.brokerSessionId) &&
    typeof value.grantRevision === 'number' &&
    isWireUInt53(value.grantRevision) &&
    Array.isArray(value.effectiveGrants) &&
    value.effectiveGrants.every(grant => typeof grant === 'string') &&
    validateEffectiveGrants(value.effectiveGrants) &&
    validateBindingNonce(value.bindingNonce)
  );
}

/** Validate the closed activation-only broker.ready input object. */
export function validateBrokerReadyParams(value: unknown): value is BrokerReadyParams {
  return (
    isRecord(value) &&
    hasExactKeys(value, BROKER_READY_PARAMS_KEYS) &&
    validateBindingNonce(value.bindingNonce)
  );
}
