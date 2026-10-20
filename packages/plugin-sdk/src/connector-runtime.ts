export interface ConnectorCardAction {
  readonly label: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ConnectorPresentation {
  readonly header: string;
  readonly body: string;
  readonly origin: 'direct' | 'callback' | 'agent' | 'system';
  readonly subtitle?: string;
  readonly footer?: string;
  readonly cardActions?: readonly ConnectorCardAction[];
}

export interface ConnectorOutboundMedia {
  readonly type: 'image' | 'file' | 'audio' | 'video';
  readonly reference: string;
  readonly fileName?: string;
}

/** Host-resolved provider target plus presentation data owned by the generic Host formatter. */
export interface ConnectorOutboundDelivery {
  readonly deliveryId: string;
  readonly externalConversationId: string;
  readonly presentation: ConnectorPresentation;
  readonly richBlocks?: readonly Readonly<Record<string, unknown>>[];
  readonly media?: readonly ConnectorOutboundMedia[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class ConnectorOutboundDeliveryError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorOutboundDeliveryError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new ConnectorOutboundDeliveryError(`${label}.${unknown} is not allowed`);
}

/** Runtime guard for Host calls crossing a dynamically loaded package boundary. */
export function requireConnectorOutboundDelivery(input: unknown): ConnectorOutboundDelivery {
  if (!object(input)) throw new ConnectorOutboundDeliveryError('connector delivery must be an object');
  closed(input, ['deliveryId', 'externalConversationId', 'presentation', 'richBlocks', 'media', 'metadata'], 'delivery');
  if (!nonEmpty(input.deliveryId)) throw new ConnectorOutboundDeliveryError('deliveryId must be non-empty');
  if (!nonEmpty(input.externalConversationId)) {
    throw new ConnectorOutboundDeliveryError('externalConversationId must be non-empty');
  }
  if (!object(input.presentation)) throw new ConnectorOutboundDeliveryError('presentation must be an object');
  const presentation = input.presentation;
  closed(presentation, ['header', 'body', 'origin', 'subtitle', 'footer', 'cardActions'], 'presentation');
  if (typeof presentation.header !== 'string' || typeof presentation.body !== 'string') {
    throw new ConnectorOutboundDeliveryError('presentation header and body must be strings');
  }
  if (!['direct', 'callback', 'agent', 'system'].includes(String(presentation.origin))) {
    throw new ConnectorOutboundDeliveryError('presentation origin is invalid');
  }
  if (!optionalString(presentation.subtitle) || !optionalString(presentation.footer)) {
    throw new ConnectorOutboundDeliveryError('presentation subtitle and footer must be strings');
  }
  if (presentation.cardActions !== undefined) {
    if (!Array.isArray(presentation.cardActions) || presentation.cardActions.some((action) => {
      if (!object(action)) return true;
      closed(action, ['label', 'value'], 'cardAction');
      return !nonEmpty(action.label) || !object(action.value);
    })) {
      throw new ConnectorOutboundDeliveryError('presentation cardActions are invalid');
    }
  }
  if (input.richBlocks !== undefined && (
    !Array.isArray(input.richBlocks) || input.richBlocks.some((block) => !object(block))
  )) {
    throw new ConnectorOutboundDeliveryError('richBlocks must be objects');
  }
  if (input.media !== undefined && (
    !Array.isArray(input.media) || input.media.some((item) => {
      if (!object(item)) return true;
      closed(item, ['type', 'reference', 'fileName'], 'media');
      return !['image', 'file', 'audio', 'video'].includes(String(item.type))
        || !nonEmpty(item.reference)
        || !optionalString(item.fileName);
    })
  )) {
    throw new ConnectorOutboundDeliveryError('media entries are invalid');
  }
  if (input.metadata !== undefined && !object(input.metadata)) {
    throw new ConnectorOutboundDeliveryError('metadata must be an object');
  }
  return structuredClone(input) as unknown as ConnectorOutboundDelivery;
}
