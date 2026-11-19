import { MatterMemoryError, type MatterSourceReaders } from './matter-source.js';

/** Server-owned permission dependency, separate from the writer's chosen return address. */
export interface MatterAccessGuard {
  threadId: string;
  messageId: string;
}

export async function captureMatterAccessGuard(
  readers: MatterSourceReaders,
): Promise<MatterAccessGuard | undefined> {
  const trigger = await readers.currentTrigger();
  if (trigger.status === 'unavailable') throw new MatterMemoryError('not_available');
  if (trigger.status === 'scoped') return { threadId: trigger.threadId, messageId: trigger.messageId };
}

export async function canReadMatterGuards(
  readers: MatterSourceReaders,
  guards: MatterAccessGuard[],
): Promise<boolean> {
  for (const guard of guards) if (!(await readers.readMessage(guard.threadId, guard.messageId))) return false;
  return true;
}
