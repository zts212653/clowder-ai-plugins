import type { MatterSourcePointer, MatterSourcePointerInput, MatterSourceReference, ReadRef } from '@clowder-ai/plugin-memory-contract/matter';
import { type MatterActor, MatterMemoryError, type MatterSourceReaders, type SourceMessage } from './matter-source.js';

function messagePointer(
  message: SourceMessage,
  origin: MatterSourcePointer['origin'],
): Extract<MatterSourcePointer, { kind: 'message' }> {
  return {
    kind: 'message',
    threadId: message.threadId,
    messageId: message.messageId,
    origin,
    author: message.author,
    timestamp: message.timestamp,
    // Raw snapshot changes and the reader's normalized citation version serve different purposes.
    sourceRevision: message.sourceRevision,
    contentRevision: message.contentRevision,
  };
}

export async function captureMatterPointer(
  readers: MatterSourceReaders,
  input: MatterSourcePointerInput,
): Promise<MatterSourcePointer> {
  if (input.messageId) {
    const message = await readers.readMessage(input.threadId, input.messageId);
    if (!message) throw new MatterMemoryError('not_available');
    return messagePointer(message, 'explicit');
  }
  if (!(await readers.canReadThread(input.threadId))) throw new MatterMemoryError('not_available');
  return { kind: 'thread', threadId: input.threadId, origin: 'explicit' };
}

export async function captureMatterInvocation(
  readers: MatterSourceReaders,
  actor: MatterActor,
): Promise<MatterSourcePointer> {
  const invocation = actor.invocation;
  if (!invocation || !(await readers.canReadThread(invocation.threadId)))
    throw new MatterMemoryError('not_available');
  if (invocation.triggerMessageId) {
    const message = await readers.readMessage(invocation.threadId, invocation.triggerMessageId);
    if (message) return messagePointer(message, 'invocation');
  }
  return { kind: 'thread', threadId: invocation.threadId, origin: 'invocation' };
}

export async function projectMatterPointer(
  readers: MatterSourceReaders,
  pointer: MatterSourcePointer,
): Promise<{ sourceStatus: 'current' | 'changed' | 'thread_only' } | null> {
  if (pointer.kind === 'thread')
    return (await readers.canReadThread(pointer.threadId)) ? { sourceStatus: 'thread_only' } : null;
  const message = await readers.readMessage(pointer.threadId, pointer.messageId);
  if (!message) return null;
  return {
    sourceStatus:
      message.sourceRevision === pointer.sourceRevision ? 'current' : 'changed',
  };
}

export function matterEntryReadRef(source: MatterSourceReference): ReadRef | undefined {
  if ('kind' in source)
    return source.kind === 'message'
      ? {
          kind: 'message',
          threadId: source.threadId,
          messageId: source.messageId,
          expectedRevision: source.contentRevision,
        }
      : undefined;
  return {
    kind: 'message',
    threadId: source.threadId,
    messageId: source.messageId,
    sourceSelection: {
      segment: source.segment,
      start: source.start,
      end: source.end,
      expectedRevision: source.sourceRevision,
      ...(source.contentBlockIndex !== undefined ? { contentBlockIndex: source.contentBlockIndex } : {}),
      ...(source.attachmentId ? { attachmentId: source.attachmentId } : {}),
    },
  };
}
