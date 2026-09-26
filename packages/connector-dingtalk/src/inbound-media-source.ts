import { createHash } from 'node:crypto';

import {
  defineMediaSourceReadAction,
  defineMediaSourceSettleAction,
  type FeatureContext,
  type MediaSourceReadResult,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

export interface InboundMediaLocator {
  readonly sourceEventId: string;
  readonly type: 'image' | 'file' | 'audio' | 'video';
  readonly platformKey: string;
  readonly fileName?: string;
  readonly duration?: number;
}

const STATE_PREFIX = 'media-source/';
const DEFINITIVE_SEND_REJECTION_CODES = new Set([
  'VALIDATION', 'PERMISSION',
]);

type DraftElement = PluginMessagingDraft['payload']['elements'][number];

export interface InboundMediaOwnership {
  readonly entries: readonly {
    readonly reference: string;
    readonly revision: number;
  }[];
}

export interface RetainedInboundMedia {
  readonly elements: readonly DraftElement[];
  readonly ownership: InboundMediaOwnership;
}

function stateKey(reference: string): string {
  return `${STATE_PREFIX}${reference}`;
}

function isLocator(value: unknown): value is InboundMediaLocator {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sourceEventId === 'string'
    && ['image', 'file', 'audio', 'video'].includes(String(candidate.type))
    && typeof candidate.platformKey === 'string';
}

function sameLocator(left: InboundMediaLocator, right: InboundMediaLocator): boolean {
  return left.sourceEventId === right.sourceEventId
    && left.type === right.type
    && left.platformKey === right.platformKey
    && left.fileName === right.fileName
    && left.duration === right.duration;
}

export function privateMediaReference(connectorId: string, sourceEventId: string, elementId: string): string {
  const digest = createHash('sha256').update(`${connectorId}\0${sourceEventId}\0${elementId}`).digest('hex');
  return `pmr_${connectorId}_${digest}`;
}

export async function retainInboundMedia(
  context: FeatureContext,
  connectorId: string,
  sourceId: string,
  sourceEventId: string,
  attachments: readonly Omit<InboundMediaLocator, 'sourceEventId'>[],
): Promise<RetainedInboundMedia> {
  const retained: Array<{ reference: string; revision: number }> = [];
  try {
    const elements = [];
    for (const [index, attachment] of attachments.entries()) {
      const elementId = `media-${index + 1}`;
      const reference = privateMediaReference(connectorId, sourceEventId, elementId);
      const locator = { sourceEventId, ...attachment };
      const inserted = await context.state.compareAndSet(stateKey(reference), null, locator);
      if (inserted.applied) {
        if (typeof inserted.revision !== 'number') {
          throw new Error('Inbound media state did not return a revision fence');
        }
        retained.push({ reference, revision: inserted.revision });
      } else {
        const existing = await context.state.get(stateKey(reference));
        if (existing === undefined || !isLocator(existing.value) || !sameLocator(existing.value, locator)) {
          throw new Error('Inbound media reference conflicts with retained locator');
        }
      }
      elements.push({
        elementId,
        kind: 'media_ref' as const,
        payload: {
          type: attachment.type,
          reference,
          sourceId,
          ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
          ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
        },
      });
    }
    return { elements, ownership: { entries: retained } };
  } catch (error) {
    const cleanup = await Promise.allSettled(retained.map(({ reference, revision }) => (
      context.state.delete(stateKey(reference), revision)
    )));
    context.log('warn', 'Inbound media locator retention failed', {
      connectorId,
      sourceEventId,
      attachmentCount: attachments.length,
      cleanupFailed: cleanup.some(result => result.status === 'rejected'),
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return {
      elements: attachments.map((attachment, index) => ({
        elementId: `media-${index + 1}`,
        kind: 'media_unavailable' as const,
        payload: {
          type: attachment.type,
          reason: 'unavailable' as const,
          ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
        },
      })),
      ownership: { entries: [] },
    };
  }
}

export async function releaseInboundMedia(
  context: FeatureContext,
  ownership: InboundMediaOwnership,
  sendError?: unknown,
): Promise<void> {
  if (sendError !== undefined) {
    const code = sendError !== null && typeof sendError === 'object'
      ? (sendError as { code?: unknown }).code
      : undefined;
    if (typeof code !== 'string' || !DEFINITIVE_SEND_REJECTION_CODES.has(code)) return;
  }
  await Promise.all(ownership.entries.map(({ reference, revision }) => (
    context.state.delete(stateKey(reference), revision)
  )));
}

export function createInboundMediaSourceActions(
  context: FeatureContext,
  download: (locator: InboundMediaLocator) => Promise<Uint8Array>,
) {
  const materialized = new Map<string, Promise<Uint8Array>>();
  const load = async (reference: string): Promise<Uint8Array | undefined> => {
    const entry = await context.state.get(stateKey(reference));
    if (entry === undefined || !isLocator(entry.value)) return undefined;
    let pending = materialized.get(reference);
    if (pending === undefined) {
      pending = download(entry.value).catch((error: unknown) => {
        materialized.delete(reference);
        throw error;
      });
      materialized.set(reference, pending);
    }
    return pending;
  };

  return {
    read: defineMediaSourceReadAction(async (input): Promise<MediaSourceReadResult> => {
      try {
        const bytes = await load(input.reference);
        if (bytes === undefined || input.offset > bytes.byteLength) {
          return { kind: 'rejected', requestId: input.requestId, code: 'MEDIA_SOURCE_UNAVAILABLE' };
        }
        const end = Math.min(input.offset + input.limit, bytes.byteLength);
        const chunk = bytes.subarray(input.offset, end);
        const done = end >= bytes.byteLength;
        return {
          kind: 'chunk', requestId: input.requestId, offset: input.offset,
          dataBase64: Buffer.from(chunk).toString('base64'), done,
          ...(done ? {} : { nextOffset: end }),
        };
      } catch {
        return { kind: 'rejected', requestId: input.requestId, code: 'MEDIA_SOURCE_UNAVAILABLE' };
      }
    }),
    settle: defineMediaSourceSettleAction(async (input) => {
      materialized.delete(input.reference);
      await context.state.delete(stateKey(input.reference));
    }),
  };
}
