import type { PluginTaskReadItem, PluginMessage, PluginTaskHost } from '@clowder-ai/plugin-sdk';
/** Read-only fields consumed by the original owner view. These are not admission/execution authority. */
export interface OwnerViewThread { readonly id: string; readonly title: string | null; readonly participants: readonly string[]; readonly deletedAt?: number | null; }
export type OwnerViewMessage = PluginMessage;
export type OwnerViewTask = PluginTaskReadItem;
export interface OwnerViewThreadStore { list(userId: string, threadIds: readonly string[]): Promise<readonly OwnerViewThread[]>; }
export interface OwnerViewMessageStore { getById(id: string): Promise<OwnerViewMessage | null | undefined>; }
export type OwnerViewTaskStore = Pick<PluginTaskHost, 'list'>;
