/**
 * Schema-agnostic compact-JSON byte-proof primitives.
 *
 * This module deliberately consumes caller-declared closed string leaves rather
 * than any wire-method schema. The later P-1a generator supplies approved
 * shapes; this kernel only measures the explicit profile it receives.
 */

export type JsonPathSegment = string | number;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };

type JsonRecord = { readonly [key: string]: JsonValue };
type MutableJsonRecord = { [key: string]: MutableJsonValue };

export const BYTE_PROOF_ENCODING_FAMILIES = [
  'ascii',
  'multibyte',
  'escaping',
] as const;

export type ByteProofEncodingFamily =
  (typeof BYTE_PROOF_ENCODING_FAMILIES)[number];

export interface ClosedStringLeafProfile {
  /** Stable caller-owned label used to identify an N+1 candidate. */
  readonly id: string;
  /** Location of a string placeholder inside the JSON template. */
  readonly path: readonly JsonPathSegment[];
  /** Schema-approved maximum measured in Unicode code points. */
  readonly maxCodePoints: number;
}

export interface ByteProofInput {
  /** A compact-JSON frame template. Only declared leaves are substituted. */
  readonly template: JsonValue;
  readonly leaves: readonly ClosedStringLeafProfile[];
  /** The caller-owned frame budget; this kernel does not choose one. */
  readonly frameLimitBytes: number;
}

export interface NPlusOneCandidate {
  readonly profileId: string;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  readonly exceedsFrameBy: number;
}

export interface EncodingByteProof {
  readonly family: ByteProofEncodingFamily;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  /** One candidate per closed leaf, with all other leaves held at their maxima. */
  readonly nPlusOne: readonly NPlusOneCandidate[];
}

export interface ByteProof {
  readonly frameLimitBytes: number;
  readonly cases: readonly EncodingByteProof[];
  readonly maxEncodedBytes: number;
  readonly worstCaseFamilies: readonly ByteProofEncodingFamily[];
}

const FAMILY_CODE_POINT: Record<ByteProofEncodingFamily, string> = {
  ascii: 'a',
  multibyte: '😀',
  escaping: '\u0000',
};

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMutableRecord(value: MutableJsonValue): value is MutableJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value: JsonValue): MutableJsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('byte-proof template must contain only finite JSON numbers');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function validatePath(profile: ClosedStringLeafProfile): void {
  if (profile.id.length === 0) throw new Error('byte-proof leaf profile id must not be empty');
  if (profile.path.length === 0) {
    throw new Error(`byte-proof profile ${profile.id} must target a nested string leaf`);
  }
  if (!Number.isSafeInteger(profile.maxCodePoints) || profile.maxCodePoints < 0) {
    throw new Error(
      `byte-proof profile ${profile.id} maxCodePoints must be a non-negative safe integer`,
    );
  }
  for (const segment of profile.path) {
    if (
      (typeof segment !== 'string' && typeof segment !== 'number') ||
      (typeof segment === 'number' && (!Number.isSafeInteger(segment) || segment < 0))
    ) {
      throw new Error(`byte-proof profile ${profile.id} has an invalid JSON path segment`);
    }
  }
}

function readChildAtPath(
  value: JsonValue,
  segment: JsonPathSegment,
  profileId: string,
): JsonValue {
  if (typeof segment === 'number') {
    if (!Array.isArray(value) || segment >= value.length) {
      throw new Error(`byte-proof profile ${profileId} has an unresolved path`);
    }
    return value[segment]!;
  }

  if (!isRecord(value) || !Object.hasOwn(value, segment)) {
    throw new Error(`byte-proof profile ${profileId} has an unresolved path`);
  }
  return value[segment]!;
}

function mutableChildAtPath(
  value: MutableJsonValue,
  segment: JsonPathSegment,
  profileId: string,
): MutableJsonValue {
  return readChildAtPath(value, segment, profileId) as MutableJsonValue;
}

function assertStringLeaf(template: JsonValue, profile: ClosedStringLeafProfile): void {
  let current = template;
  for (const segment of profile.path) current = readChildAtPath(current, segment, profile.id);
  if (typeof current !== 'string') {
    throw new Error(`byte-proof profile ${profile.id} must resolve to a string leaf`);
  }
}

function replaceStringLeaf(
  template: MutableJsonValue,
  profile: ClosedStringLeafProfile,
  replacement: string,
): void {
  let parent = template;
  const lastIndex = profile.path.length - 1;

  for (const [index, segment] of profile.path.entries()) {
    if (index === lastIndex) {
      if (typeof segment === 'number') {
        if (!Array.isArray(parent) || segment >= parent.length || typeof parent[segment] !== 'string') {
          throw new Error(`byte-proof profile ${profile.id} must resolve to a string leaf`);
        }
        parent[segment] = replacement;
        return;
      }

      if (!isMutableRecord(parent) || !Object.hasOwn(parent, segment) || typeof parent[segment] !== 'string') {
        throw new Error(`byte-proof profile ${profile.id} must resolve to a string leaf`);
      }
      parent[segment] = replacement;
      return;
    }
    parent = mutableChildAtPath(parent, segment, profile.id);
  }
}

function assertFiniteJsonNumbers(value: JsonValue): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('byte-proof template must contain only finite JSON numbers');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteJsonNumbers(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertFiniteJsonNumbers(item);
  }
}

function encodedBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function materialize(
  input: ByteProofInput,
  family: ByteProofEncodingFamily,
  nPlusOneProfileId?: string,
): JsonValue {
  const materialized = cloneJson(input.template);
  const codePoint = FAMILY_CODE_POINT[family];

  for (const profile of input.leaves) {
    const count = profile.maxCodePoints + (profile.id === nPlusOneProfileId ? 1 : 0);
    replaceStringLeaf(materialized, profile, codePoint.repeat(count));
  }

  return materialized;
}

function validateInput(input: ByteProofInput): void {
  if (!Number.isSafeInteger(input.frameLimitBytes) || input.frameLimitBytes < 0) {
    throw new Error('byte-proof frameLimitBytes must be a non-negative safe integer');
  }
  if (input.leaves.length === 0) {
    throw new Error('byte-proof requires at least one closed string leaf profile');
  }
  assertFiniteJsonNumbers(input.template);

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const profile of input.leaves) {
    validatePath(profile);
    if (ids.has(profile.id)) throw new Error(`duplicate byte-proof profile id: ${profile.id}`);
    const pathKey = JSON.stringify(profile.path);
    if (paths.has(pathKey)) throw new Error(`duplicate byte-proof profile path: ${pathKey}`);
    ids.add(profile.id);
    paths.add(pathKey);
    assertStringLeaf(input.template, profile);
  }
}

/**
 * Calculates compact UTF-8 JSON sizes for ASCII, multibyte, and escaped-string
 * maxima. N+1 candidates are structurally over their individual leaf profile;
 * `fitsFrame` records the separate, caller-supplied frame-budget fact.
 */
export function calculateByteProof(input: ByteProofInput): ByteProof {
  validateInput(input);

  const cases = BYTE_PROOF_ENCODING_FAMILIES.map((family): EncodingByteProof => {
    const bytesAtMaximum = encodedBytes(materialize(input, family));
    const nPlusOne = input.leaves.map((profile): NPlusOneCandidate => {
      const candidateBytes = encodedBytes(materialize(input, family, profile.id));
      return {
        profileId: profile.id,
        encodedBytes: candidateBytes,
        fitsFrame: candidateBytes <= input.frameLimitBytes,
        exceedsFrameBy: Math.max(0, candidateBytes - input.frameLimitBytes),
      };
    });

    return {
      family,
      encodedBytes: bytesAtMaximum,
      fitsFrame: bytesAtMaximum <= input.frameLimitBytes,
      nPlusOne,
    };
  });

  const maxEncodedBytes = Math.max(...cases.map(({ encodedBytes: bytes }) => bytes));
  return {
    frameLimitBytes: input.frameLimitBytes,
    cases,
    maxEncodedBytes,
    worstCaseFamilies: cases
      .filter(({ encodedBytes: bytes }) => bytes === maxEncodedBytes)
      .map(({ family }) => family),
  };
}
