/**
 * Derived compact-JSON byte bounds for the beta.10 M0-B lifecycle rows.
 *
 * This production module constructs maximum legal frames directly from the
 * closed public grammar. The generic byte-proof kernel remains test-only;
 * tests independently recompute these maxima to prevent registry drift.
 */

import { MAX_FRAME_BYTES } from './constants.js';
import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  ERROR_CODE_TO_MESSAGE,
  INVALID_REQUEST_CODE,
  PARSE_ERROR_CODE,
  STANDARD_ERROR_CODES,
} from './errors.js';
import { MAX_GRANT_ITEMS, VALID_CAPABILITIES } from './grants.js';
import { REQUEST_ID_MAX_LENGTH } from './request-id.js';
import { PING_NONCE_MAX_LENGTH } from './row-shapes.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';

export const LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES = [
  'ascii',
  'multibyte',
  'escaping',
] as const;

export type LifecycleByteProofEncodingFamily =
  (typeof LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES)[number];

export interface LifecycleNPlusOneByteProof {
  readonly leaf: string;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
}

export interface LifecycleEncodedByteProofCase {
  readonly family: LifecycleByteProofEncodingFamily;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  readonly nPlusOne: readonly LifecycleNPlusOneByteProof[];
}

export interface LifecycleEncodedByteProof {
  readonly maxEncodedBytes: number;
  readonly cases: readonly LifecycleEncodedByteProofCase[];
}

export interface LifecycleRequestRowEncodedByteBounds {
  readonly maxEncodedRequestBytes: number;
  readonly maxEncodedResultBytes: number;
  readonly maxEncodedErrorBytes: number;
}



const MAX_REQUEST_ID = 'a'.repeat(REQUEST_ID_MAX_LENGTH);


function byteLength(value: object): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function familyCharacter(family: LifecycleByteProofEncodingFamily): string {
  switch (family) {
    case 'ascii':
      return 'a';
    case 'multibyte':
      return '😀';
    case 'escaping':
      return '\u0000';
  }
}

function proof(
  maximumFrame: (family: LifecycleByteProofEncodingFamily) => object,
  nPlusOneFrames: (
    family: LifecycleByteProofEncodingFamily,
  ) => readonly { readonly leaf: string; readonly frame: object }[],
): LifecycleEncodedByteProof {
  const cases = LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES.map((family) => {
    const encodedBytes = byteLength(maximumFrame(family));
    return {
      family,
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
      nPlusOne: nPlusOneFrames(family).map(({ leaf, frame }) => {
        const witnessBytes = byteLength(frame);
        return {
          leaf,
          encodedBytes: witnessBytes,
          fitsFrame: witnessBytes <= MAX_FRAME_BYTES,
        };
      }),
    };
  });

  return {
    maxEncodedBytes: Math.max(...cases.map(proofCase => proofCase.encodedBytes)),
    cases,
  };
}

function repeatedProof(
  maximumFrame: object,
  nPlusOneFrames: readonly { readonly leaf: string; readonly frame: object }[],
): LifecycleEncodedByteProof {
  return proof(() => maximumFrame, () => nPlusOneFrames);
}





// The closed vocabulary can grow while the frozen wire array limit stays 28.
// A legal maximal snapshot contains the 28 longest distinct encoded names.




function pingRequestFrame(
  family: LifecycleByteProofEncodingFamily,
  requestId = MAX_REQUEST_ID,
  nonceLength: number = PING_NONCE_MAX_LENGTH,
): object {
  return {
    jsonrpc: '2.0',
    id: requestId,
    method: 'host.lifecycle.ping',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { nonce: familyCharacter(family).repeat(nonceLength) },
    },
  };
}

function pingResultFrame(
  family: LifecycleByteProofEncodingFamily,
  requestId = MAX_REQUEST_ID,
  nonceLength: number = PING_NONCE_MAX_LENGTH,
): object {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: { nonce: familyCharacter(family).repeat(nonceLength) },
  };
}

export const HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF = proof(
  family => pingRequestFrame(family),
  family => [
    {
      leaf: 'requestId',
      frame: pingRequestFrame(family, 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1)),
    },
    {
      leaf: 'nonce',
      frame: pingRequestFrame(family, MAX_REQUEST_ID, PING_NONCE_MAX_LENGTH + 1),
    },
  ],
);

export const HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF = proof(
  family => pingResultFrame(family),
  family => [
    {
      leaf: 'requestId',
      frame: pingResultFrame(family, 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1)),
    },
    {
      leaf: 'nonce',
      frame: pingResultFrame(family, MAX_REQUEST_ID, PING_NONCE_MAX_LENGTH + 1),
    },
  ],
);









function standardErrorEnvelopes() {
  return STANDARD_ERROR_CODES.flatMap((code) => {
    const error = { code, message: ERROR_CODE_TO_MESSAGE[code] };
    const arm = `standard:${code}`;
    if (code === PARSE_ERROR_CODE) return [{ arm, id: null, error }];
    if (code === INVALID_REQUEST_CODE) {
      return [
        { arm: `${arm}:null`, id: null, error },
        { arm, id: MAX_REQUEST_ID, error },
      ];
    }
    return [{ arm, id: MAX_REQUEST_ID, error }];
  });
}

function deadlineExpiredEnvelope(requestId = MAX_REQUEST_ID) {
  return {
    arm: 'application:DEADLINE_EXPIRED',
    id: requestId,
    error: {
      code: DEADLINE_EXPIRED_CODE,
      message: DEADLINE_EXPIRED_MESSAGE,
      data: {},
    },
  };
}

function errorProof(
  envelopes: readonly {
    readonly arm: string;
    readonly id: string | null;
    readonly error: object;
  }[],
): LifecycleEncodedByteProof {
  const maximumEnvelope = envelopes.reduce((maximum, envelope) =>
    byteLength({ jsonrpc: '2.0', id: envelope.id, error: envelope.error }) >
    byteLength({ jsonrpc: '2.0', id: maximum.id, error: maximum.error })
      ? envelope
      : maximum,
  );
  const witnesses = envelopes
    .filter((envelope): envelope is typeof envelope & { readonly id: string } =>
      envelope.id !== null,
    )
    .map(envelope => ({
      leaf: `${envelope.arm}.requestId`,
      frame: {
        jsonrpc: '2.0',
        id: 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
        error: envelope.error,
      },
    }));

  return repeatedProof(
    { jsonrpc: '2.0', id: maximumEnvelope.id, error: maximumEnvelope.error },
    witnesses,
  );
}

export const HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF = errorProof(
  standardErrorEnvelopes(),
);



export const LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS = {
 'host.lifecycle.ping': {
  maxEncodedRequestBytes:HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF.maxEncodedBytes,
  maxEncodedResultBytes:HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF.maxEncodedBytes,
  maxEncodedErrorBytes:HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF.maxEncodedBytes,
 },
} as const satisfies {readonly 'host.lifecycle.ping':LifecycleRequestRowEncodedByteBounds};
