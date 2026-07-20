/**
 * WireUInt53 — the single contract-owned numeric profile.
 * Mechanized from the #1165 frozen shape.
 *
 * Raw JSON lexeme: canonical decimal digits 0|[1-9][0-9]*
 * No sign, no decimal point, no exponent, no leading zeros.
 * Raw token length ≤ 16 characters.
 * Parsed value: non-negative safe integer.
 */

/** Maximum safe integer (2^53 - 1). */
export const WIRE_UINT53_MAX = 9_007_199_254_740_991 as const;

/** Pattern for canonical decimal integer raw tokens. */
export const WIRE_UINT53_RAW_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** Maximum raw token length (digit count of 2^53-1). */
export const WIRE_UINT53_MAX_RAW_LENGTH = 16 as const;

/**
 * Validate a parsed number as a WireUInt53.
 * Checks Number.isSafeInteger and non-negative.
 */
export function isWireUInt53(value: number, min: number = 0, max: number = WIRE_UINT53_MAX): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Validate a raw JSON token as a canonical WireUInt53 lexeme.
 * Must be checked BEFORE JSON.parse (pre-dispatch).
 */
export function isCanonicalUInt53Token(rawToken: string): boolean {
  if (rawToken.length === 0 || rawToken.length > WIRE_UINT53_MAX_RAW_LENGTH) return false;
  return WIRE_UINT53_RAW_PATTERN.test(rawToken);
}
