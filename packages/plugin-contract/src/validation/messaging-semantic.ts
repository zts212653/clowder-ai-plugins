import { MESSAGING_BOUNDS } from '../generated/contract.generated.js';

export interface SemanticValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SemanticValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SemanticValidationError[];
}

interface MessageElementLike {
  readonly payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadBytes(payload: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return undefined;
  }
}

function elementGroups(schemaRef: string, value: unknown): readonly unknown[][] {
  if (!isRecord(value)) return [];

  if (schemaRef === 'MessageDraft' || schemaRef === 'MessageEnvelope') {
    const payload = value['payload'];
    return isRecord(payload) && Array.isArray(payload['elements'])
      ? [payload['elements']]
      : [];
  }

  if (
    schemaRef === 'AppendElementsRequest' ||
    schemaRef === 'MessageElementsAppendEvent'
  ) {
    return Array.isArray(value['elements']) ? [value['elements']] : [];
  }

  if (schemaRef === 'MessagePublishEvent') {
    const envelope = value['envelope'];
    return isRecord(envelope)
      ? elementGroups('MessageEnvelope', envelope)
      : [];
  }

  if (schemaRef === 'MessageOutputEvent') {
    return value['type'] === 'message.publish'
      ? elementGroups('MessagePublishEvent', value)
      : elementGroups('MessageElementsAppendEvent', value);
  }

  if (schemaRef === 'SubscriptionReadResponse' && Array.isArray(value['events'])) {
    return value['events'].flatMap((event) =>
      elementGroups('MessageOutputEvent', event),
    );
  }

  if (schemaRef === 'SnapshotResponse' && Array.isArray(value['envelopes'])) {
    return value['envelopes'].flatMap((envelope) =>
      elementGroups('MessageEnvelope', envelope),
    );
  }

  if (schemaRef === 'root') {
    if ('address' in value && 'payload' in value) {
      return elementGroups('MessageDraft', value);
    }
    if ('occurredAt' in value && 'payload' in value) {
      return elementGroups('MessageEnvelope', value);
    }
    if ('handle' in value && 'elements' in value) {
      return elementGroups('AppendElementsRequest', value);
    }
    if (typeof value['type'] === 'string') {
      return elementGroups('MessageOutputEvent', value);
    }
    if ('events' in value) {
      return elementGroups('SubscriptionReadResponse', value);
    }
    if ('envelopes' in value) {
      return elementGroups('SnapshotResponse', value);
    }
  }

  return [];
}

export function validateMessagingSemantics(
  schemaRef: string,
  value: unknown,
): SemanticValidationResult {
  const errors: SemanticValidationError[] = [];

  for (const [groupIndex, elements] of elementGroups(schemaRef, value).entries()) {
    let totalBytes = 0;

    for (const [elementIndex, rawElement] of elements.entries()) {
      const path = `/elementGroups/${groupIndex}/${elementIndex}/payload`;
      const payload = isRecord(rawElement)
        ? (rawElement as MessageElementLike).payload
        : undefined;
      const bytes = payloadBytes(payload);

      if (bytes === undefined) {
        errors.push({ path, message: 'element payload must be JSON-serializable' });
        continue;
      }

      totalBytes += bytes;
      if (bytes > MESSAGING_BOUNDS.maxElementPayloadBytes) {
        errors.push({
          path,
          message: `element payload exceeds ${MESSAGING_BOUNDS.maxElementPayloadBytes} bytes`,
        });
      }
    }

    if (totalBytes > MESSAGING_BOUNDS.maxTotalPayloadBytes) {
      errors.push({
        path: `/elementGroups/${groupIndex}`,
        message: `total element payload exceeds ${MESSAGING_BOUNDS.maxTotalPayloadBytes} bytes`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
