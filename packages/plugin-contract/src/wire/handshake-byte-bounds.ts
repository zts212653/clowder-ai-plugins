/**
 * Derived compact-JSON byte bounds for the beta.8 handshake rows.
 *
 * This production module owns only the published summary metadata. The
 * generic byte-proof kernel remains test-only; keeping it out of the packed
 * artifact prevents consumers from accidentally treating a proof generator
 * as a runtime protocol dependency. The test-only templates independently
 * recompute these values from the same closed grammar.
 */

import { MAX_FRAME_BYTES } from './constants.js';
import {
  HANDSHAKE_REJECTED_CODE,
  HANDSHAKE_REJECTED_MESSAGE,
  HANDSHAKE_REJECT_REASONS,
} from './errors.js';
import {
  BINDING_NONCE_MAX_LENGTH,
  HANDSHAKE_VERSION_MAX_LENGTH,
  HOST_IDENTIFIER_MAX_LENGTH,
  PACKAGE_DIGEST_LENGTH,
  PLUGIN_ID_MAX_LENGTH,
} from './handshake.js';
import { VALID_CAPABILITIES } from './grants.js';
import { REQUEST_ID_MAX_LENGTH } from './request-id.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';

/** Encoding families used for raw UTF-8 boundary evidence. */
export const HANDSHAKE_BYTE_PROOF_ENCODING_FAMILIES = [
  'ascii',
  'multibyte',
  'escaping',
] as const;

export type HandshakeByteProofEncodingFamily =
  (typeof HANDSHAKE_BYTE_PROOF_ENCODING_FAMILIES)[number];

/** One rejected N+1 candidate measured alongside a maximum frame. */
export interface HandshakeNPlusOneByteProof {
  readonly leaf: string;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
}

/** Raw UTF-8 measurement for one encoding family. */
export interface HandshakeEncodedByteProofCase {
  readonly family: HandshakeByteProofEncodingFamily;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  readonly nPlusOne: readonly HandshakeNPlusOneByteProof[];
}

/** Published max plus the raw-family proof cases from which it is derived. */
export interface HandshakeEncodedByteProof {
  readonly maxEncodedBytes: number;
  readonly cases: readonly HandshakeEncodedByteProofCase[];
}

/** Per-row frame maxima consumed by the public method registry. */
export interface HandshakeRowEncodedByteBounds {
  readonly maxEncodedRequestBytes: number;
  readonly maxEncodedResultBytes: number;
  readonly maxEncodedErrorBytes: number;
}

interface BoundedLeaf {
  readonly id: string;
  readonly maxCodePoints: number;
  readonly asciiOnly?: boolean;
}

const FAMILY_CODE_POINT: Record<HandshakeByteProofEncodingFamily, string> = {
  ascii: 'a',
  multibyte: '😀',
  escaping: '\u0000',
};

const MAX_REQUEST_ID = 'a'.repeat(REQUEST_ID_MAX_LENGTH);
const MAX_PACKAGE_DIGEST = `sha512-${'A'.repeat(PACKAGE_DIGEST_LENGTH - 9)}==`;
const MAX_EFFECTIVE_GRANTS = [...VALID_CAPABILITIES];
const MAX_HANDSHAKE_REJECT_REASON = HANDSHAKE_REJECT_REASONS.reduce(
  (longest, value) => (value.length > longest.length ? value : longest),
);

function valueFor(
  family: HandshakeByteProofEncodingFamily,
  leaf: BoundedLeaf,
  nPlusOneLeaf?: string,
): string {
  const codePoint = leaf.asciiOnly ? FAMILY_CODE_POINT.ascii : FAMILY_CODE_POINT[family];
  return codePoint.repeat(leaf.maxCodePoints + Number(leaf.id === nPlusOneLeaf));
}

function semverFor(nPlusOneLeaf?: string, leaf?: 'contractVersion' | 'wireVersion'): string {
  return `0.0.0-${'a'.repeat(
    HANDSHAKE_VERSION_MAX_LENGTH - 6 + Number(nPlusOneLeaf === leaf),
  )}`;
}

function measureProof(
  leaves: readonly BoundedLeaf[],
  frameFor: (
    family: HandshakeByteProofEncodingFamily,
    nPlusOneLeaf?: string,
  ) => object,
): HandshakeEncodedByteProof {
  const cases = HANDSHAKE_BYTE_PROOF_ENCODING_FAMILIES.map((family) => {
    const encodedBytes = Buffer.byteLength(JSON.stringify(frameFor(family)), 'utf8');
    return {
      family,
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
      nPlusOne: leaves.map((leaf) => {
        const nPlusOneBytes = Buffer.byteLength(
          JSON.stringify(frameFor(family, leaf.id)),
          'utf8',
        );
        return {
          leaf: leaf.id,
          encodedBytes: nPlusOneBytes,
          fitsFrame: nPlusOneBytes <= MAX_FRAME_BYTES,
        };
      }),
    };
  });

  return {
    maxEncodedBytes: Math.max(...cases.map(({ encodedBytes }) => encodedBytes)),
    cases,
  };
}

const HELLO_REQUEST_LEAVES = [
  { id: 'requestId', maxCodePoints: REQUEST_ID_MAX_LENGTH, asciiOnly: true },
  { id: 'pluginId', maxCodePoints: PLUGIN_ID_MAX_LENGTH },
  { id: 'contractVersion', maxCodePoints: HANDSHAKE_VERSION_MAX_LENGTH, asciiOnly: true },
  { id: 'wireVersion', maxCodePoints: HANDSHAKE_VERSION_MAX_LENGTH, asciiOnly: true },
] as const;

const HELLO_RESULT_LEAVES = [
  { id: 'requestId', maxCodePoints: REQUEST_ID_MAX_LENGTH, asciiOnly: true },
  { id: 'pluginId', maxCodePoints: PLUGIN_ID_MAX_LENGTH },
  { id: 'contractVersion', maxCodePoints: HANDSHAKE_VERSION_MAX_LENGTH, asciiOnly: true },
  { id: 'wireVersion', maxCodePoints: HANDSHAKE_VERSION_MAX_LENGTH, asciiOnly: true },
  { id: 'pluginInstanceId', maxCodePoints: HOST_IDENTIFIER_MAX_LENGTH },
  { id: 'brokerSessionId', maxCodePoints: HOST_IDENTIFIER_MAX_LENGTH },
  { id: 'bindingNonce', maxCodePoints: BINDING_NONCE_MAX_LENGTH },
] as const;

const READY_REQUEST_LEAVES = [
  { id: 'requestId', maxCodePoints: REQUEST_ID_MAX_LENGTH, asciiOnly: true },
  { id: 'bindingNonce', maxCodePoints: BINDING_NONCE_MAX_LENGTH },
] as const;

const HANDSHAKE_ERROR_LEAVES = [
  { id: 'requestId', maxCodePoints: REQUEST_ID_MAX_LENGTH, asciiOnly: true },
] as const;

function helloRequestFrame(
  family: HandshakeByteProofEncodingFamily,
  nPlusOneLeaf?: string,
): object {
  const leaf = (entry: (typeof HELLO_REQUEST_LEAVES)[number]) =>
    valueFor(family, entry, nPlusOneLeaf);
  return {
    jsonrpc: '2.0',
    id: leaf(HELLO_REQUEST_LEAVES[0]),
    method: 'broker.hello',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: {
        pluginId: leaf(HELLO_REQUEST_LEAVES[1]),
        packageDigest: MAX_PACKAGE_DIGEST,
        contractVersion: semverFor(nPlusOneLeaf, 'contractVersion'),
        wireVersion: semverFor(nPlusOneLeaf, 'wireVersion'),
      },
    },
  };
}

function helloResultFrame(
  family: HandshakeByteProofEncodingFamily,
  nPlusOneLeaf?: string,
): object {
  const leaf = (entry: (typeof HELLO_RESULT_LEAVES)[number]) =>
    valueFor(family, entry, nPlusOneLeaf);
  return {
    jsonrpc: '2.0',
    id: leaf(HELLO_RESULT_LEAVES[0]),
    result: {
      pluginId: leaf(HELLO_RESULT_LEAVES[1]),
      packageDigest: MAX_PACKAGE_DIGEST,
      contractVersion: semverFor(nPlusOneLeaf, 'contractVersion'),
      wireVersion: semverFor(nPlusOneLeaf, 'wireVersion'),
      pluginInstanceId: leaf(HELLO_RESULT_LEAVES[4]),
      brokerSessionId: leaf(HELLO_RESULT_LEAVES[5]),
      grantRevision: WIRE_UINT53_MAX,
      effectiveGrants: MAX_EFFECTIVE_GRANTS,
      bindingNonce: leaf(HELLO_RESULT_LEAVES[6]),
    },
  };
}

function readyRequestFrame(
  family: HandshakeByteProofEncodingFamily,
  nPlusOneLeaf?: string,
): object {
  const leaf = (entry: (typeof READY_REQUEST_LEAVES)[number]) =>
    valueFor(family, entry, nPlusOneLeaf);
  return {
    jsonrpc: '2.0',
    id: leaf(READY_REQUEST_LEAVES[0]),
    method: 'broker.ready',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { bindingNonce: leaf(READY_REQUEST_LEAVES[1]) },
    },
  };
}

function handshakeRejectedFrame(
  family: HandshakeByteProofEncodingFamily,
  nPlusOneLeaf?: string,
): object {
  const requestId = valueFor(family, HANDSHAKE_ERROR_LEAVES[0], nPlusOneLeaf);
  return {
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: HANDSHAKE_REJECTED_CODE,
      message: HANDSHAKE_REJECTED_MESSAGE,
      data: { reason: MAX_HANDSHAKE_REJECT_REASON },
    },
  };
}

/** Raw proof of the largest legal broker.hello request. */
export const BROKER_HELLO_REQUEST_BYTE_PROOF = measureProof(
  HELLO_REQUEST_LEAVES,
  helloRequestFrame,
);

/** Raw proof of the largest legal broker.hello success result. */
export const BROKER_HELLO_RESULT_BYTE_PROOF = measureProof(
  HELLO_RESULT_LEAVES,
  helloResultFrame,
);

/** Raw proof of the largest legal broker.ready request. */
export const BROKER_READY_REQUEST_BYTE_PROOF = measureProof(
  READY_REQUEST_LEAVES,
  readyRequestFrame,
);

/** Raw proof of the largest handshake rejection envelope. */
export const HANDSHAKE_REJECTED_ERROR_BYTE_PROOF = measureProof(
  HANDSHAKE_ERROR_LEAVES,
  handshakeRejectedFrame,
);

/** broker.ready succeeds with the exact JSON-RPC result `null`. */
export const BROKER_READY_MAX_ENCODED_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({ jsonrpc: '2.0', id: MAX_REQUEST_ID, result: null }),
  'utf8',
);

export const BROKER_HELLO_MAX_ENCODED_REQUEST_BYTES =
  BROKER_HELLO_REQUEST_BYTE_PROOF.maxEncodedBytes;
export const BROKER_HELLO_MAX_ENCODED_RESULT_BYTES =
  BROKER_HELLO_RESULT_BYTE_PROOF.maxEncodedBytes;
export const BROKER_HELLO_MAX_ENCODED_ERROR_BYTES =
  HANDSHAKE_REJECTED_ERROR_BYTE_PROOF.maxEncodedBytes;
export const BROKER_READY_MAX_ENCODED_REQUEST_BYTES =
  BROKER_READY_REQUEST_BYTE_PROOF.maxEncodedBytes;
export const BROKER_READY_MAX_ENCODED_ERROR_BYTES =
  HANDSHAKE_REJECTED_ERROR_BYTE_PROOF.maxEncodedBytes;

/**
 * The exact per-row summary consumed by the registry. No byte value is
 * hand-entered in the registry; all maxima are derived above from the closed
 * grammar and raw UTF-8 serialization.
 */
export const HANDSHAKE_ROW_ENCODED_BYTE_BOUNDS = {
  'broker.hello': {
    maxEncodedRequestBytes: BROKER_HELLO_MAX_ENCODED_REQUEST_BYTES,
    maxEncodedResultBytes: BROKER_HELLO_MAX_ENCODED_RESULT_BYTES,
    maxEncodedErrorBytes: BROKER_HELLO_MAX_ENCODED_ERROR_BYTES,
  },
  'broker.ready': {
    maxEncodedRequestBytes: BROKER_READY_MAX_ENCODED_REQUEST_BYTES,
    maxEncodedResultBytes: BROKER_READY_MAX_ENCODED_RESULT_BYTES,
    maxEncodedErrorBytes: BROKER_READY_MAX_ENCODED_ERROR_BYTES,
  },
} as const satisfies Record<'broker.hello' | 'broker.ready', HandshakeRowEncodedByteBounds>;
