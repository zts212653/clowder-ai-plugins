import {
  validateMessagingRowInput,
  validateMessagingRowResult,
  isMediaSourceReadInput,
  isMediaSourceReadResult,
  isMediaSourceSettleInput,
  type DeliveryPresentationContext,
  type HostMessagingLifecycleInput,
  type HostMessagingLifecycleResult,
  type LifecycleRejectReason,
  type MediaReadInput,
  type MediaReadResult,
  type MediaSourceReadInput,
  type MediaSourceReadResult,
  type MediaSourceSettleInput,
  type MediaUnavailableMessageElement,
  type MediaWarningMessageElement,
} from '@clowder-ai/plugin-contract';
import { isDeepStrictEqual } from 'node:util';

const MEDIA_CHUNK_BYTES = 512 * 1024;
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface PluginMediaReader {
  read(reference: string): AsyncIterable<Uint8Array>;
}

export type MediaChunkReader = (input: MediaReadInput) => Promise<MediaReadResult>;

export type MediaSourceReadAction = (
  input: MediaSourceReadInput,
) => MediaSourceReadResult | Promise<MediaSourceReadResult>;

export type MediaSourceSettleAction = (
  input: MediaSourceSettleInput,
) => void | Promise<void>;

export class MediaSourceActionInputError extends TypeError {
  constructor(message = 'media-source action input or result is invalid') {
    super(message);
    this.name = 'MediaSourceActionInputError';
  }
}

/** Validate both sides of a declared media-source read callback. */
export function defineMediaSourceReadAction(
  handler: MediaSourceReadAction,
): (input: unknown) => Promise<MediaSourceReadResult> {
  return async (input) => {
    if (!isMediaSourceReadInput(input)) throw new MediaSourceActionInputError();
    const result = await handler(structuredClone(input));
    if (!isMediaSourceReadResult(result) || result.requestId !== input.requestId) {
      throw new MediaSourceActionInputError();
    }
    return structuredClone(result);
  };
}

/** Validate the Host's final import disposition before package cleanup runs. */
export function defineMediaSourceSettleAction(
  handler: MediaSourceSettleAction,
): (input: unknown) => Promise<void> {
  return async (input) => {
    if (!isMediaSourceSettleInput(input)) throw new MediaSourceActionInputError();
    await handler(structuredClone(input));
  };
}

export class MediaReadProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaReadProtocolError';
  }
}

/** Build the only SDK media-read surface: a bounded stream, never a read-all helper. */
export function createMediaReader(readChunk: MediaChunkReader): PluginMediaReader {
  return Object.freeze({
    read(reference: string): AsyncIterable<Uint8Array> {
      if (!nonEmpty(reference)) throw new MediaReadProtocolError('media reference must be non-empty');
      return Object.freeze({
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          let offset = 0;
          while (true) {
            const input = { reference, offset, limit: MEDIA_CHUNK_BYTES };
            const inputValidation = validateMessagingRowInput('media.read', input);
            if (!inputValidation.valid) {
              throw new MediaReadProtocolError('SDK produced an invalid media.read input');
            }
            const candidate = await readChunk(inputValidation.value);
            const resultValidation = validateMessagingRowResult('media.read', candidate);
            if (!resultValidation.valid) {
              throw new MediaReadProtocolError('Host returned an invalid media.read result');
            }
            const result = resultValidation.value;
            if (result.offset !== offset) {
              throw new MediaReadProtocolError('Host returned a media chunk at the wrong offset');
            }
            const bytes = Buffer.from(result.dataBase64, 'base64');
            if (bytes.byteLength > MEDIA_CHUNK_BYTES) {
              throw new MediaReadProtocolError('Host returned a media chunk above the requested limit');
            }
            if (bytes.length > 0) yield new Uint8Array(bytes);
            if (result.done) return;
            if (result.nextOffset !== offset + bytes.byteLength) {
              throw new MediaReadProtocolError('Host returned a discontinuous media cursor');
            }
            offset = result.nextOffset;
          }
        },
      });
    },
  });
}

export class LifecycleActionInputError extends TypeError {
  constructor(message = 'lifecycle action input is invalid') {
    super(message);
    this.name = 'LifecycleActionInputError';
  }
}

export class PresentationDeliveryInputError extends TypeError {
  constructor(message = 'delivery presentation is required by the subscription') {
    super(message);
    this.name = 'PresentationDeliveryInputError';
  }
}

export function requireLifecycleInput(input: unknown): HostMessagingLifecycleInput {
  const validation = validateMessagingRowInput('host.messaging.lifecycle', input);
  if (!validation.valid) throw new LifecycleActionInputError();
  return structuredClone(validation.value);
}

export type LifecycleAction = (
  input: HostMessagingLifecycleInput,
) => HostMessagingLifecycleResult | Promise<HostMessagingLifecycleResult>;

/** Close a package lifecycle callback at the contract boundary before user code runs. */
export function defineLifecycleAction(handler: LifecycleAction): (input: unknown) => Promise<HostMessagingLifecycleResult> {
  return async (input: unknown) => {
    const lifecycle = requireLifecycleInput(input);
    const result = await handler(lifecycle);
    const validation = validateMessagingRowResult('host.messaging.lifecycle', result);
    if (!validation.valid || result.deliveryId !== lifecycle.deliveryId) {
      throw new LifecycleActionInputError('lifecycle action result is invalid');
    }
    return structuredClone(validation.value);
  };
}

export function isDeliveryPresentationContext(value: unknown): value is DeliveryPresentationContext {
  return validateMessagingRowInput('host.messaging.lifecycle', {
    lifecycleId: 'sdk-presentation-guard',
    deliveryId: 'sdk-presentation-guard',
    threadId: 'sdk-presentation-guard',
    state: 'started',
    presentation: value,
  }).valid;
}

/** Fail closed before package code when a presentation v1/v2 subscription receives an incomplete delivery. */
export function requireDeliveryPresentation(input: unknown): DeliveryPresentationContext {
  if (!isRecord(input) || !isDeliveryPresentationContext(input.presentation)) {
    throw new PresentationDeliveryInputError();
  }
  return structuredClone(input.presentation);
}

export function isMediaUnavailableMessageElement(value: unknown): value is MediaUnavailableMessageElement {
  if (!isRecord(value) || value.kind !== 'media_unavailable') return false;
  return validateMessagingRowInput('messaging.send', elementGuardDraft([value])).valid;
}

export type LifecycleTransitionRejectReason =
  | 'DELIVERY_CONFLICT'
  | 'INVALID_HISTORY'
  | 'OUT_OF_ORDER';

export type LifecycleTransitionDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replay' }
  | { readonly kind: 'reject'; readonly reason: LifecycleTransitionRejectReason };

function nextLifecycleDecision(
  history: readonly HostMessagingLifecycleInput[],
  event: HostMessagingLifecycleInput,
): LifecycleTransitionDecision {
  const sameDelivery = history.find(candidate => candidate.deliveryId === event.deliveryId);
  if (sameDelivery !== undefined) {
    return isDeepStrictEqual(sameDelivery, event)
      ? { kind: 'replay' }
      : { kind: 'reject', reason: 'DELIVERY_CONFLICT' };
  }
  if (history.some(candidate => candidate.lifecycleId !== event.lifecycleId)) {
    return { kind: 'reject', reason: 'INVALID_HISTORY' };
  }
  if (history.length === 0) {
    return event.state === 'started'
      ? { kind: 'accept' }
      : { kind: 'reject', reason: 'OUT_OF_ORDER' };
  }
  const last = history.at(-1)!;
  if (last.state === 'settled') return { kind: 'reject', reason: 'OUT_OF_ORDER' };
  if (last.state === 'blocked') {
    return event.state === 'settled'
      ? { kind: 'accept' }
      : { kind: 'reject', reason: 'OUT_OF_ORDER' };
  }
  if (event.state === 'started') return { kind: 'reject', reason: 'OUT_OF_ORDER' };
  if (event.state === 'blocked' && history.some(candidate => candidate.state === 'blocked')) {
    return { kind: 'reject', reason: 'OUT_OF_ORDER' };
  }
  if (event.state === 'settled' && history.some(candidate => candidate.state === 'settled')) {
    return { kind: 'reject', reason: 'OUT_OF_ORDER' };
  }
  return { kind: 'accept' };
}

/**
 * Decide a lifecycle transition without owning persistence. Packages persist only accepted events;
 * replay is idempotent, while malformed history and out-of-order events fail closed.
 */
export function decideLifecycleTransition(
  historyInput: readonly unknown[],
  eventInput: unknown,
): LifecycleTransitionDecision {
  let event: HostMessagingLifecycleInput;
  let history: HostMessagingLifecycleInput[];
  try {
    event = requireLifecycleInput(eventInput);
    history = historyInput.map(requireLifecycleInput);
  } catch {
    return { kind: 'reject', reason: 'INVALID_HISTORY' };
  }

  const rebuilt: HostMessagingLifecycleInput[] = [];
  for (const candidate of history) {
    const decision = nextLifecycleDecision(rebuilt, candidate);
    if (decision.kind !== 'accept') return { kind: 'reject', reason: 'INVALID_HISTORY' };
    rebuilt.push(candidate);
  }
  return nextLifecycleDecision(rebuilt, event);
}

/** Map an SDK lifecycle decision onto the closed wire rejection taxonomy. */
export function lifecycleRejectReason(
  decision: Extract<LifecycleTransitionDecision, { readonly kind: 'reject' }>,
): LifecycleRejectReason {
  switch (decision.reason) {
    case 'OUT_OF_ORDER':
      return 'LIFECYCLE_OUT_OF_ORDER';
    case 'DELIVERY_CONFLICT':
      return 'LIFECYCLE_DELIVERY_CONFLICT';
    case 'INVALID_HISTORY':
      return 'PLUGIN_INTERNAL';
  }
}

export function isMediaWarningMessageElement(value: unknown): value is MediaWarningMessageElement {
  if (!isRecord(value) || value.kind !== 'media_warning' || !isRecord(value.payload)) {
    return false;
  }
  const { mediaElementId } = value.payload;
  if (!nonEmpty(mediaElementId)) return false;
  return validateMessagingRowInput('messaging.send', elementGuardDraft([
    {
      elementId: mediaElementId,
      kind: 'media_ref',
      payload: { type: 'file', reference: 'hmr_sdk-element-guard' },
    },
    value,
  ])).valid;
}

function elementGuardDraft(elements: readonly unknown[]): unknown {
  return {
    address: { kind: 'thread_handle', handle: 'sdk-element-guard' },
    idempotencyKey: 'sdk-element-guard',
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements,
    },
  };
}
