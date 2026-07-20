/**
 * RequestId — wire-protocol request correlation identifier.
 * Mechanized verbatim from #1165 maintainer R4-intake (5005069362).
 *
 * String-only, ASCII, attempt correlation only (not authoritative for settlement).
 * Response echo must be byte-for-byte equal.
 */

/** Branded RequestId type. */
export type RequestId = string & { readonly __brand: 'RequestId' };

/** ASCII grammar pattern for RequestId values. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Minimum length in characters/bytes (ASCII). */
export const REQUEST_ID_MIN_LENGTH = 1 as const;

/** Maximum length in characters/bytes (ASCII). */
export const REQUEST_ID_MAX_LENGTH = 128 as const;

/** Minimum compact-JSON encoded bytes (including quotes). */
export const REQUEST_ID_MIN_ENCODED_BYTES = 3 as const; // 1 + 2 quotes

/** Maximum compact-JSON encoded bytes (including quotes). */
export const REQUEST_ID_MAX_ENCODED_BYTES = 130 as const; // 128 + 2 quotes

/**
 * Validate a value as a RequestId.
 * Returns the validated RequestId or null if invalid.
 * Does NOT check in-flight uniqueness (that is a runtime concern).
 */
export function validateRequestId(value: unknown): RequestId | null {
  if (typeof value !== 'string') return null;
  if (value.length < REQUEST_ID_MIN_LENGTH || value.length > REQUEST_ID_MAX_LENGTH) return null;
  if (!REQUEST_ID_PATTERN.test(value)) return null;
  return value as RequestId;
}

/**
 * Check if a raw JSON token could be a RequestId.
 * Used in pre-dispatch: detects string tokens with valid grammar.
 * Non-string types (numeric, null, boolean, object, array) return false.
 */
export function isRequestIdShaped(value: unknown): value is string {
  return typeof value === 'string';
}
