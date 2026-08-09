/**
 * Derived compact-JSON byte bounds for the beta.9 C-2 events.publish row.
 *
 * Signal payloads are bounded by their compact encoded byte length, not by a
 * string code-point count. That makes the generic leaf proof insufficient for
 * row 13: this module constructs an exactly 64 KiB JSON object independently
 * for ASCII, multibyte, and escaped-string families, then measures the entire
 * request envelope and one rejected N+1 witness for every bounded leaf.
 */

import type { EventsPublishInput } from '../generated/contract.generated.js';
import { SIGNAL_PAYLOAD_MAX_ENCODED_BYTES } from '../validation/signals.js';
import { MAX_FRAME_BYTES } from './constants.js';
import { METHOD_NOT_FOUND_CODE, METHOD_NOT_FOUND_MESSAGE } from './errors.js';
import { REQUEST_ID_MAX_LENGTH } from './request-id.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';

export const EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES = [
  'ascii',
  'multibyte',
  'escaping',
] as const;

export type EventsPublishByteProofEncodingFamily =
  (typeof EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES)[number];

export const SIGNAL_TYPE_MAX_LENGTH = 128 as const;
export const SIGNAL_EVENT_ID_MAX_LENGTH = 128 as const;
export const SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH = 256 as const;
export const SIGNAL_OCCURRED_AT_MAX_LENGTH = 30 as const;
export const SIGNAL_SOURCE_HANDLE_MAX_LENGTH = 512 as const;

const MAX_OCCURRED_AT = '2026-08-09T04:12:31.123456789Z';

interface EventsPublishProofInput {
  readonly requestId: string;
  readonly input: EventsPublishInput;
  readonly payloadEncodedBytes: number;
}

export interface EventsPublishNPlusOneWitness extends EventsPublishProofInput {
  readonly leaf:
    | 'requestId'
    | 'signalType'
    | 'eventId'
    | 'idempotencyKey'
    | 'occurredAt'
    | 'payloadBytes'
    | 'sourceHandle';
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
}

export interface EventsPublishEncodedByteProofCase {
  readonly family: EventsPublishByteProofEncodingFamily;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  readonly nPlusOne: readonly {
    readonly leaf: string;
    readonly encodedBytes: number;
    readonly fitsFrame: boolean;
  }[];
}

export interface EventsPublishEncodedByteProof {
  readonly maxEncodedBytes: number;
  readonly cases: readonly EventsPublishEncodedByteProofCase[];
}

export interface EventsPublishRowEncodedByteBounds {
  readonly maxEncodedRequestBytes: number;
  readonly maxEncodedResultBytes: number;
  readonly maxEncodedErrorBytes: number;
}

function byteLength(value: object): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function familyCharacter(family: EventsPublishByteProofEncodingFamily): string {
  switch (family) {
    case 'ascii':
      return 'a';
    case 'multibyte':
      return '😀';
    case 'escaping':
      // Quote is admissible in idempotency/source handles and requires JSON
      // escaping. Control characters would be a larger escape but are forbidden
      // by those leaf grammars, so using them would not prove a legal maximum.
      return '"';
  }
}

function exactPayload(
  family: EventsPublishByteProofEncodingFamily,
  extraBytes = 0,
): Readonly<Record<string, unknown>> {
  const targetBytes = SIGNAL_PAYLOAD_MAX_ENCODED_BYTES + extraBytes;
  const dataCharacter = family === 'escaping' ? '\u0000' : familyCharacter(family);
  const empty = { data: '', pad: '' };
  const staticBytes = byteLength(empty);
  const unitBytes = byteLength({ data: dataCharacter, pad: '' }) - staticBytes;
  const repetitions = Math.floor((targetBytes - staticBytes) / unitBytes);
  const data = dataCharacter.repeat(repetitions);
  const usedBytes = byteLength({ data, pad: '' });
  const payload = { data, pad: 'a'.repeat(targetBytes - usedBytes) };
  if (byteLength(payload) !== targetBytes) {
    throw new Error(`failed to construct exact ${targetBytes}-byte signal payload`);
  }
  return payload;
}

function signalType(length: number = SIGNAL_TYPE_MAX_LENGTH): string {
  return `a.${'a'.repeat(length - 2)}`;
}

function inputFor(
  family: EventsPublishByteProofEncodingFamily,
  overrides: Partial<EventsPublishInput> = {},
  payloadExtraBytes = 0,
): EventsPublishInput {
  const character = familyCharacter(family);
  return {
    signalType: signalType(),
    eventId: 'a'.repeat(SIGNAL_EVENT_ID_MAX_LENGTH),
    idempotencyKey: character.repeat(SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH),
    occurredAt: MAX_OCCURRED_AT,
    payload: exactPayload(family, payloadExtraBytes),
    source: { handle: character.repeat(SIGNAL_SOURCE_HANDLE_MAX_LENGTH) },
    ...overrides,
  };
}

function requestFrame(requestId: string, input: EventsPublishInput): object {
  return {
    jsonrpc: '2.0',
    id: requestId,
    method: 'events.publish',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input,
    },
  };
}

export function eventsPublishMaximumInput(
  family: EventsPublishByteProofEncodingFamily,
): EventsPublishProofInput {
  const input = inputFor(family);
  return {
    requestId: 'a'.repeat(REQUEST_ID_MAX_LENGTH),
    input,
    payloadEncodedBytes: byteLength(input.payload),
  };
}

export function eventsPublishNPlusOneInputs(
  family: EventsPublishByteProofEncodingFamily,
): readonly EventsPublishNPlusOneWitness[] {
  const maximum = eventsPublishMaximumInput(family);
  const character = familyCharacter(family);
  const occurredAtNPlusOne = `${MAX_OCCURRED_AT.slice(0, -1)}0Z`;
  const candidates: ReadonlyArray<{
    readonly leaf: EventsPublishNPlusOneWitness['leaf'];
    readonly requestId?: string;
    readonly input: EventsPublishInput;
  }> = [
    {
      leaf: 'requestId',
      requestId: 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
      input: maximum.input,
    },
    {
      leaf: 'signalType',
      input: inputFor(family, { signalType: signalType(SIGNAL_TYPE_MAX_LENGTH + 1) }),
    },
    {
      leaf: 'eventId',
      input: inputFor(family, { eventId: 'a'.repeat(SIGNAL_EVENT_ID_MAX_LENGTH + 1) }),
    },
    {
      leaf: 'idempotencyKey',
      input: inputFor(family, {
        idempotencyKey: character.repeat(SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      }),
    },
    {
      leaf: 'occurredAt',
      input: inputFor(family, { occurredAt: occurredAtNPlusOne }),
    },
    {
      leaf: 'payloadBytes',
      input: inputFor(family, {}, 1),
    },
    {
      leaf: 'sourceHandle',
      input: inputFor(family, {
        source: { handle: character.repeat(SIGNAL_SOURCE_HANDLE_MAX_LENGTH + 1) },
      }),
    },
  ];

  return candidates.map(({ leaf, requestId = maximum.requestId, input }) => {
    const encodedBytes = byteLength(requestFrame(requestId, input));
    return {
      leaf,
      requestId,
      input,
      payloadEncodedBytes: byteLength(input.payload),
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
    };
  });
}

function requestProof(): EventsPublishEncodedByteProof {
  const cases = EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES.map((family) => {
    const maximum = eventsPublishMaximumInput(family);
    const encodedBytes = byteLength(requestFrame(maximum.requestId, maximum.input));
    return {
      family,
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
      nPlusOne: eventsPublishNPlusOneInputs(family).map(
        ({ leaf, encodedBytes: witnessBytes, fitsFrame }) => ({
          leaf,
          encodedBytes: witnessBytes,
          fitsFrame,
        }),
      ),
    };
  });
  return {
    maxEncodedBytes: Math.max(...cases.map(({ encodedBytes }) => encodedBytes)),
    cases,
  };
}

function fixedLeafProof(
  leaf: 'requestId' | 'publicationId',
  maxLength: number,
  frame: (length: number) => object,
): EventsPublishEncodedByteProof {
  const encodedBytes = byteLength(frame(maxLength));
  const nPlusOneBytes = byteLength(frame(maxLength + 1));
  return {
    maxEncodedBytes: encodedBytes,
    cases: EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES.map((family) => ({
      family,
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
      nPlusOne: [
        {
          leaf,
          encodedBytes: nPlusOneBytes,
          fitsFrame: nPlusOneBytes <= MAX_FRAME_BYTES,
        },
      ],
    })),
  };
}

export const EVENTS_PUBLISH_REQUEST_BYTE_PROOF = requestProof();

export const EVENTS_PUBLISH_RESULT_BYTE_PROOF = fixedLeafProof(
  'publicationId',
  SIGNAL_EVENT_ID_MAX_LENGTH,
  (length) => ({
    jsonrpc: '2.0',
    id: 'a'.repeat(REQUEST_ID_MAX_LENGTH),
    result: {
      publicationId: 'a'.repeat(length),
      disposition: 'duplicate',
    },
  }),
);

export const EVENTS_PUBLISH_ERROR_BYTE_PROOF = fixedLeafProof(
  'requestId',
  REQUEST_ID_MAX_LENGTH,
  (length) => ({
    jsonrpc: '2.0',
    id: 'a'.repeat(length),
    error: {
      code: METHOD_NOT_FOUND_CODE,
      message: METHOD_NOT_FOUND_MESSAGE,
    },
  }),
);

export const EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS = {
  maxEncodedRequestBytes: EVENTS_PUBLISH_REQUEST_BYTE_PROOF.maxEncodedBytes,
  maxEncodedResultBytes: EVENTS_PUBLISH_RESULT_BYTE_PROOF.maxEncodedBytes,
  maxEncodedErrorBytes: EVENTS_PUBLISH_ERROR_BYTE_PROOF.maxEncodedBytes,
} as const satisfies EventsPublishRowEncodedByteBounds;
