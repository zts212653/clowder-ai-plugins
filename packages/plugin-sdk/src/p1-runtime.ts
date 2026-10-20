import {validateMessagingRowInput,type DeliveryPresentationContext,type MediaUnavailableMessageElement,type MediaWarningMessageElement} from '@clowder-ai/plugin-contract';

function nonEmpty(value: unknown): value is string {return typeof value === 'string' && value.length > 0;}
function isRecord(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}

export class PresentationDeliveryInputError extends TypeError {
  constructor(message = 'delivery presentation is required by the subscription') {
    super(message);
    this.name = 'PresentationDeliveryInputError';
  }
}

export function isDeliveryPresentationContext(value: unknown): value is DeliveryPresentationContext {
  return validateMessagingRowInput('host.messaging.deliver', {
    kind: 'execution_status',
    executionId: 'sdk-presentation-guard',
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
