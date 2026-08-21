/**
 * Derived compact-JSON byte bounds for the beta.11 M0-C messaging rows.
 *
 * Structural maxima are built from the closed public grammar and measured as
 * compact UTF-8 JSON. Read and snapshot results are intentionally different:
 * their legal structural maxima can exceed one frame, so their published
 * bound is the final-frame assembler budget rather than a fictional
 * structural maximum.
 */

import type {
  AppendElementsRequest,
  AppendReceipt,
  MessageDraft,
  MessageElement,
  MessageEnvelope,
  SendReceipt,
} from '../generated/contract.generated.js';
import type {
  DeliverInput,
  DeliverResult,
  MessagingAckRequest,
  MessagingAckResult,
  ReadInput,
  SendInput,
  SnapshotInput,
  SubscribeInput,
  SubscribeResult,
} from './row-shapes.js';
import {
  MAX_ELEMENT_PAYLOAD_BYTES,
  MAX_ELEMENTS_PER_MESSAGE,
  MAX_ELEMENTS_PER_OPERATION,
  MAX_FRAME_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  MAX_WHISPER_TARGETS,
} from './constants.js';
import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  DELIVERY_REJECTED_CODE,
  DELIVERY_REJECTED_MESSAGE,
  DELIVERY_REJECT_REASONS,
  DOMAIN_ERROR_CODE,
  DOMAIN_ERROR_MESSAGE,
  ERROR_CODE_TO_MESSAGE,
  INVALID_REQUEST_CODE,
  PARSE_ERROR_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  SNAPSHOT_UNAVAILABLE_MESSAGE,
  SNAPSHOT_UNAVAILABLE_REASONS,
  STANDARD_ERROR_CODES,
} from './errors.js';
import { REQUEST_ID_MAX_LENGTH } from './request-id.js';
import type { MessagingRowMethod } from '../validation/messaging-wire.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';

export const MESSAGING_BYTE_PROOF_ENCODING_FAMILIES = [
  'ascii',
  'multibyte',
  'escaping',
] as const;

export type MessagingByteProofEncodingFamily =
  (typeof MESSAGING_BYTE_PROOF_ENCODING_FAMILIES)[number];

export type MessagingByteProofBasis = 'structural-maximum' | 'assembler-budget';

export interface MessagingNPlusOneByteProof {
  readonly leaf: string;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
}

export interface MessagingEncodedByteProofCase {
  readonly family: MessagingByteProofEncodingFamily;
  readonly encodedBytes: number;
  readonly fitsFrame: boolean;
  readonly nPlusOne: readonly MessagingNPlusOneByteProof[];
}

export interface MessagingEncodedByteProof {
  readonly basis: MessagingByteProofBasis;
  readonly maxEncodedBytes: number;
  readonly cases: readonly MessagingEncodedByteProofCase[];
}

export interface MessagingRowEncodedByteBounds {
  readonly maxEncodedRequestBytes: number;
  readonly maxEncodedResultBytes: number;
  readonly maxEncodedErrorBytes: number;
}

export interface MessagingNPlusOneInputWitness {
  readonly leaf: string;
  readonly input: unknown;
}

export interface MessagingNPlusOneResultWitness {
  readonly leaf: string;
  readonly result: unknown;
}

const MAX_REQUEST_ID = 'a'.repeat(REQUEST_ID_MAX_LENGTH);
const ESCAPING_SCALARS = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x0b, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
] as const;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function familyScalar(
  family: MessagingByteProofEncodingFamily,
  salt = 0,
): string {
  switch (family) {
    case 'ascii':
      return String.fromCodePoint(0x61 + (salt % 26));
    case 'multibyte':
      return String.fromCodePoint(0x1f408 + (salt % 16));
    case 'escaping':
      return String.fromCodePoint(ESCAPING_SCALARS[salt % ESCAPING_SCALARS.length]);
  }
}

function maximumString(
  family: MessagingByteProofEncodingFamily,
  length: number,
  salt = 0,
): string {
  if (length === 0) return '';
  return `${familyScalar(family).repeat(length - 1)}${familyScalar(family, salt)}`;
}

function exactPayload(
  family: MessagingByteProofEncodingFamily,
  targetBytes: number,
): Readonly<Record<string, unknown>> {
  const scalar = familyScalar(family);
  const empty = { data: '', pad: '' };
  const staticBytes = byteLength(empty);
  const unitBytes = byteLength({ data: scalar, pad: '' }) - staticBytes;
  const repetitions = Math.floor((targetBytes - staticBytes) / unitBytes);
  const data = scalar.repeat(repetitions);
  const usedBytes = byteLength({ data, pad: '' });
  const payload = { data, pad: 'a'.repeat(targetBytes - usedBytes) };
  if (byteLength(payload) !== targetBytes) {
    throw new Error(`failed to construct exact ${targetBytes}-byte messaging payload`);
  }
  return payload;
}

function maximumElements(
  family: MessagingByteProofEncodingFamily,
  count: number,
  totalPayloadBytes = MAX_TOTAL_PAYLOAD_BYTES,
): readonly MessageElement[] {
  if (totalPayloadBytes % count !== 0) {
    throw new Error('messaging proof payload budget must divide evenly across elements');
  }
  const payloadBytes = totalPayloadBytes / count;
  return Array.from({ length: count }, (_, index) => ({
    elementId: maximumString(family, 128, index),
    kind: 'rich_block' as const,
    payload: exactPayload(family, payloadBytes),
    derivedFromElementId: maximumString(family, 128, index + count),
    epistemicStatus: 'observation' as const,
  }));
}

function maximumAudience(family: MessagingByteProofEncodingFamily) {
  return {
    kind: 'whisper' as const,
    targets: Array.from({ length: MAX_WHISPER_TARGETS }, (_, index) =>
      maximumString(family, 256, index)),
  };
}

function maximumOrigin(family: MessagingByteProofEncodingFamily) {
  return {
    kind: 'external' as const,
    connectorId: maximumString(family, 256, 1),
    sourceAddress: {
      connectorId: maximumString(family, 256, 2),
      chatId: maximumString(family, 512, 3),
      messageId: maximumString(family, 512, 4),
    },
  };
}

function maximumDraft(family: MessagingByteProofEncodingFamily): MessageDraft {
  return {
    address: {
      kind: 'connector_binding',
      handle: maximumString(family, 256, 5),
    },
    draftAudience: maximumAudience(family),
    idempotencyKey: maximumString(family, 200, 6),
    sourceEventId: maximumString(family, 512, 7),
    replyTo: maximumString(family, 256, 8),
    payload: {
      provenance: {
        origin: maximumOrigin(family),
        epistemicStatus: 'observation',
      },
      elements: maximumElements(family, MAX_ELEMENTS_PER_OPERATION),
      correlationId: maximumString(family, 256, 9),
      causationId: maximumString(family, 256, 10),
    },
  };
}

function maximumEnvelope(family: MessagingByteProofEncodingFamily): MessageEnvelope {
  return {
    messageId: maximumString(family, 512, 1),
    revision: WIRE_UINT53_MAX,
    threadId: maximumString(family, 512, 2),
    replyTo: maximumString(family, 256, 3),
    actor: { kind: 'system', id: maximumString(family, 512, 4) },
    audience: maximumAudience(family),
    occurredAt: '+010000-01-01T00:00:00.000Z',
    payload: {
      provenance: {
        origin: maximumOrigin(family),
        epistemicStatus: 'observation',
      },
      elements: maximumElements(family, MAX_ELEMENTS_PER_MESSAGE),
      correlationId: maximumString(family, 256, 5),
      causationId: maximumString(family, 256, 6),
    },
  };
}

function requestFrame(method: MessagingRowMethod, input: unknown, requestId = MAX_REQUEST_ID) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params: { meta: { deadlineUnixMs: WIRE_UINT53_MAX }, input },
  };
}

function resultFrame(result: unknown, requestId = MAX_REQUEST_ID) {
  return { jsonrpc: '2.0', id: requestId, result };
}

export function messagingMaximumRequestInput(
  method: MessagingRowMethod,
  family: MessagingByteProofEncodingFamily,
): SendInput | AppendElementsRequest | SubscribeInput | ReadInput |
  MessagingAckRequest | SnapshotInput | DeliverInput {
  switch (method) {
    case 'messaging.send':
      return maximumDraft(family);
    case 'messaging.appendElements':
      return {
        handle: { kind: 'message', token: maximumString(family, 512, 1) },
        operationId: maximumString(family, 200, 2),
        baseRevision: WIRE_UINT53_MAX,
        elements: maximumElements(family, MAX_ELEMENTS_PER_OPERATION),
      };
    case 'messaging.subscribe':
      return { handle: maximumString(family, 256, 1) };
    case 'messaging.read':
      return { subscriptionId: maximumString(family, 128, 1), limit: 32 };
    case 'messaging.ack':
      return {
        subscriptionId: maximumString(family, 128, 1),
        ackToken: maximumString(family, 512, 2),
      };
    case 'messaging.snapshot':
      return {
        subscriptionId: maximumString(family, 128, 1),
        maxItems: 64,
        pageToken: maximumString(family, 512, 2),
      };
    case 'host.messaging.deliver':
      return {
        deliveryId: maximumString(family, 128, 1),
        threadHandle: {
          kind: 'thread_handle',
          handle: maximumString(family, 256, 2),
        },
        envelope: maximumEnvelope(family),
      };
  }
}

export function messagingMaximumResult(
  method: Exclude<MessagingRowMethod, 'messaging.read' | 'messaging.snapshot'>,
  family: MessagingByteProofEncodingFamily,
): SendReceipt | AppendReceipt | SubscribeResult | MessagingAckResult | DeliverResult {
  switch (method) {
    case 'messaging.send':
      return {
        messageId: maximumString(family, 512, 1),
        threadId: maximumString(family, 512, 2),
        revision: WIRE_UINT53_MAX,
        messageHandle: { kind: 'message', token: maximumString(family, 512, 3) },
        publishSequence: WIRE_UINT53_MAX,
      };
    case 'messaging.appendElements':
      return {
        messageId: maximumString(family, 512, 1),
        revision: WIRE_UINT53_MAX,
        appendSequence: WIRE_UINT53_MAX,
        appliedElementIds: Array.from({ length: MAX_ELEMENTS_PER_OPERATION }, (_, index) =>
          maximumString(family, 128, index)),
      };
    case 'messaging.subscribe':
      return { subscriptionId: maximumString(family, 128, 1) };
    case 'messaging.ack':
      return null;
    case 'host.messaging.deliver':
      return { deliveryId: maximumString(family, 128, 1) };
  }
}

function payloadNPlusOneDraft(
  family: MessagingByteProofEncodingFamily,
  aggregate: boolean,
): MessageDraft {
  const draft = maximumDraft(family);
  const elements = aggregate
    ? Array.from({ length: 5 }, (_, index) => ({
        elementId: maximumString(family, 128, index),
        kind: 'rich_block' as const,
        payload: exactPayload(
          family,
          index === 4 ? 20 : MAX_ELEMENT_PAYLOAD_BYTES,
        ),
      }))
    : [{
        elementId: maximumString(family, 128),
        kind: 'rich_block' as const,
        payload: exactPayload(family, MAX_ELEMENT_PAYLOAD_BYTES + 1),
      }];
  return { ...draft, payload: { ...draft.payload, elements } };
}

export function messagingRequestNPlusOneInputs(
  method: MessagingRowMethod,
  family: MessagingByteProofEncodingFamily,
): readonly MessagingNPlusOneInputWitness[] {
  switch (method) {
    case 'messaging.send': {
      const maximum = maximumDraft(family);
      return [
        { leaf: 'idempotencyKey', input: { ...maximum, idempotencyKey: maximumString(family, 201) } },
        { leaf: 'payloadBytes', input: payloadNPlusOneDraft(family, false) },
        { leaf: 'aggregatePayloadBytes', input: payloadNPlusOneDraft(family, true) },
      ];
    }
    case 'messaging.appendElements': {
      const maximum = messagingMaximumRequestInput(method, family) as AppendElementsRequest;
      return [
        { leaf: 'operationId', input: { ...maximum, operationId: maximumString(family, 201) } },
        {
          leaf: 'payloadBytes',
          input: {
            ...maximum,
            elements: [{
              elementId: maximumString(family, 128),
              kind: 'rich_block',
              payload: exactPayload(family, MAX_ELEMENT_PAYLOAD_BYTES + 1),
            }],
          },
        },
      ];
    }
    case 'messaging.subscribe':
      return [{ leaf: 'handle', input: { handle: maximumString(family, 257) } }];
    case 'messaging.read':
      return [
        { leaf: 'subscriptionId', input: { subscriptionId: maximumString(family, 129), limit: 32 } },
        { leaf: 'limit', input: { subscriptionId: maximumString(family, 128), limit: 33 } },
      ];
    case 'messaging.ack':
      return [
        { leaf: 'subscriptionId', input: { subscriptionId: maximumString(family, 129), ackToken: 'a' } },
        { leaf: 'ackToken', input: { subscriptionId: 'a', ackToken: maximumString(family, 513) } },
      ];
    case 'messaging.snapshot':
      return [
        { leaf: 'subscriptionId', input: { subscriptionId: maximumString(family, 129), maxItems: 64 } },
        { leaf: 'maxItems', input: { subscriptionId: 'a', maxItems: 65 } },
        { leaf: 'pageToken', input: { subscriptionId: 'a', maxItems: 64, pageToken: maximumString(family, 513) } },
      ];
    case 'host.messaging.deliver': {
      const maximum = messagingMaximumRequestInput(method, family) as DeliverInput;
      return [
        { leaf: 'deliveryId', input: { ...maximum, deliveryId: maximumString(family, 129) } },
        {
          leaf: 'threadHandle.handle',
          input: {
            ...maximum,
            threadHandle: { kind: 'thread_handle', handle: maximumString(family, 257) },
          },
        },
      ];
    }
  }
}

export function messagingResultNPlusOneInputs(
  method: Exclude<MessagingRowMethod, 'messaging.read' | 'messaging.snapshot'>,
  family: MessagingByteProofEncodingFamily,
): readonly MessagingNPlusOneResultWitness[] {
  const maximum = messagingMaximumResult(method, family);
  switch (method) {
    case 'messaging.send':
      return [{ leaf: 'messageId', result: { ...maximum, messageId: maximumString(family, 513) } }];
    case 'messaging.appendElements':
      return [{
        leaf: 'appliedElementIds',
        result: {
          ...maximum,
          appliedElementIds: Array.from({ length: 33 }, (_, index) =>
            maximumString(family, 128, index)),
        },
      }];
    case 'messaging.subscribe':
      return [{ leaf: 'subscriptionId', result: { subscriptionId: maximumString(family, 129) } }];
    case 'messaging.ack':
      return [];
    case 'host.messaging.deliver':
      return [{ leaf: 'deliveryId', result: { deliveryId: maximumString(family, 129) } }];
  }
}

function structuralProof(
  maximumFrames: (family: MessagingByteProofEncodingFamily) => object,
  nPlusOneFrames: (family: MessagingByteProofEncodingFamily) => readonly {
    readonly leaf: string;
    readonly frame: object;
  }[],
): MessagingEncodedByteProof {
  const cases = MESSAGING_BYTE_PROOF_ENCODING_FAMILIES.map((family) => {
    const encodedBytes = byteLength(maximumFrames(family));
    return {
      family,
      encodedBytes,
      fitsFrame: encodedBytes <= MAX_FRAME_BYTES,
      nPlusOne: nPlusOneFrames(family).map(({ leaf, frame }) => {
        const witnessBytes = byteLength(frame);
        return { leaf, encodedBytes: witnessBytes, fitsFrame: witnessBytes <= MAX_FRAME_BYTES };
      }),
    };
  });
  return {
    basis: 'structural-maximum',
    maxEncodedBytes: Math.max(...cases.map(({ encodedBytes }) => encodedBytes)),
    cases,
  };
}

function assemblerBudgetProof(): MessagingEncodedByteProof {
  return {
    basis: 'assembler-budget',
    maxEncodedBytes: MAX_FRAME_BYTES,
    cases: MESSAGING_BYTE_PROOF_ENCODING_FAMILIES.map((family) => ({
      family,
      encodedBytes: MAX_FRAME_BYTES,
      fitsFrame: true,
      nPlusOne: [{
        leaf: 'frameBytes',
        encodedBytes: MAX_FRAME_BYTES + 1,
        fitsFrame: false,
      }],
    })),
  };
}

function requestProof(method: MessagingRowMethod): MessagingEncodedByteProof {
  return structuralProof(
    family => requestFrame(method, messagingMaximumRequestInput(method, family)),
    family => [
      {
        leaf: 'requestId',
        frame: requestFrame(
          method,
          messagingMaximumRequestInput(method, family),
          'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
        ),
      },
      ...messagingRequestNPlusOneInputs(method, family).map(({ leaf, input }) => ({
        leaf,
        frame: requestFrame(method, input),
      })),
    ],
  );
}

function resultProof(
  method: Exclude<MessagingRowMethod, 'messaging.read' | 'messaging.snapshot'>,
): MessagingEncodedByteProof {
  return structuralProof(
    family => resultFrame(messagingMaximumResult(method, family)),
    family => [
      {
        leaf: 'requestId',
        frame: resultFrame(
          messagingMaximumResult(method, family),
          'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
        ),
      },
      ...messagingResultNPlusOneInputs(method, family).map(({ leaf, result }) => ({
        leaf,
        frame: resultFrame(result),
      })),
    ],
  );
}

const MESSAGING_ERROR_CODES = [
  'VALIDATION',
  'PERMISSION',
  'NOT_FOUND',
  'CONFLICT',
  'RETRYABLE_INFLIGHT',
  'STALE_CURSOR',
] as const;

function longest(values: readonly string[]): string {
  return values.reduce((current, candidate) =>
    candidate.length > current.length ? candidate : current);
}

function standardErrorEnvelopes() {
  return STANDARD_ERROR_CODES.flatMap((code) => {
    const error = { code, message: ERROR_CODE_TO_MESSAGE[code] };
    if (code === PARSE_ERROR_CODE) return [{ id: null, error }];
    if (code === INVALID_REQUEST_CODE) {
      return [{ id: null, error }, { id: MAX_REQUEST_ID, error }];
    }
    return [{ id: MAX_REQUEST_ID, error }];
  });
}

function applicationErrorEnvelopes(method: MessagingRowMethod) {
  const common = [
    {
      id: MAX_REQUEST_ID,
      error: {
        code: DOMAIN_ERROR_CODE,
        message: DOMAIN_ERROR_MESSAGE,
        data: { code: longest(MESSAGING_ERROR_CODES) },
      },
    },
    {
      id: MAX_REQUEST_ID,
      error: {
        code: DEADLINE_EXPIRED_CODE,
        message: DEADLINE_EXPIRED_MESSAGE,
        data: {},
      },
    },
  ];
  if (method === 'messaging.snapshot') {
    return [...common, {
      id: MAX_REQUEST_ID,
      error: {
        code: SNAPSHOT_UNAVAILABLE_CODE,
        message: SNAPSHOT_UNAVAILABLE_MESSAGE,
        data: { reason: longest(SNAPSHOT_UNAVAILABLE_REASONS) },
      },
    }];
  }
  if (method === 'host.messaging.deliver') {
    return [{
      id: MAX_REQUEST_ID,
      error: {
        code: DELIVERY_REJECTED_CODE,
        message: DELIVERY_REJECTED_MESSAGE,
        data: { reason: longest(DELIVERY_REJECT_REASONS) },
      },
    }];
  }
  return common;
}

function errorProof(method: MessagingRowMethod): MessagingEncodedByteProof {
  const envelopes = [...standardErrorEnvelopes(), ...applicationErrorEnvelopes(method)];
  const maximum = envelopes.reduce((current, candidate) =>
    byteLength({ jsonrpc: '2.0', ...candidate }) >
    byteLength({ jsonrpc: '2.0', ...current }) ? candidate : current);
  return structuralProof(
    () => ({ jsonrpc: '2.0', ...maximum }),
    () => [{
      leaf: 'requestId',
      frame: {
        jsonrpc: '2.0',
        id: 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
        error: maximum.error,
      },
    }],
  );
}

export const MESSAGING_REQUEST_BYTE_PROOFS = Object.fromEntries(
  ([
    'messaging.send',
    'messaging.appendElements',
    'messaging.subscribe',
    'messaging.read',
    'messaging.ack',
    'messaging.snapshot',
    'host.messaging.deliver',
  ] as const).map(method => [method, requestProof(method)]),
) as Readonly<Record<MessagingRowMethod, MessagingEncodedByteProof>>;

export const MESSAGING_RESULT_BYTE_PROOFS = {
  'messaging.send': resultProof('messaging.send'),
  'messaging.appendElements': resultProof('messaging.appendElements'),
  'messaging.subscribe': resultProof('messaging.subscribe'),
  'messaging.read': assemblerBudgetProof(),
  'messaging.ack': resultProof('messaging.ack'),
  'messaging.snapshot': assemblerBudgetProof(),
  'host.messaging.deliver': resultProof('host.messaging.deliver'),
} as const satisfies Readonly<Record<MessagingRowMethod, MessagingEncodedByteProof>>;

export const MESSAGING_ERROR_BYTE_PROOFS = Object.fromEntries(
  (Object.keys(MESSAGING_REQUEST_BYTE_PROOFS) as MessagingRowMethod[])
    .map(method => [method, errorProof(method)]),
) as Readonly<Record<MessagingRowMethod, MessagingEncodedByteProof>>;

export const MESSAGING_ROW_ENCODED_BYTE_BOUNDS = Object.fromEntries(
  (Object.keys(MESSAGING_REQUEST_BYTE_PROOFS) as MessagingRowMethod[]).map(method => [
    method,
    {
      maxEncodedRequestBytes: MESSAGING_REQUEST_BYTE_PROOFS[method].maxEncodedBytes,
      maxEncodedResultBytes: MESSAGING_RESULT_BYTE_PROOFS[method].maxEncodedBytes,
      maxEncodedErrorBytes: MESSAGING_ERROR_BYTE_PROOFS[method].maxEncodedBytes,
    },
  ]),
) as Readonly<Record<MessagingRowMethod, MessagingRowEncodedByteBounds>>;
