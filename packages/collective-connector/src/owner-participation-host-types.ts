import type { PluginTaskReadItem, PluginQueueProgress, PluginSourceProgressFact } from '@clowder-ai/plugin-sdk';
/** Read-only fields consumed by the original owner view. These are not admission/execution authority. */
export interface OwnerViewThread { readonly id: string; readonly title: string | null; readonly createdBy: string;
  readonly participants: readonly string[]; readonly deletedAt?: number | null; }
export type OwnerQueueCustody = PluginQueueProgress;
export type OwnerViewMessage = Pick<PluginSourceProgressFact, 'id' | 'userId' | 'threadId' | 'source' | 'queueCustody'>;
export type OwnerViewTask = PluginTaskReadItem;
export interface OwnerViewThreadStore { list(userId: string): Promise<readonly OwnerViewThread[]>; }
export interface OwnerViewMessageStore { getById(id: string): Promise<OwnerViewMessage | null | undefined>; }
export interface OwnerViewTaskStore { listByKind(kind: 'work'): Promise<readonly OwnerViewTask[]>; }
