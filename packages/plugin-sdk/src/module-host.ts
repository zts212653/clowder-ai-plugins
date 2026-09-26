import type {
  DeliveryPresentationContext,
  MediaReadInput,
  MediaReadResult,
  MessageDraft,
  MessageEnvelope,
} from '@clowder-ai/plugin-contract';

export type ModulePluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginStorageEntry {
  /** Opaque monotonic fence. Later writes to the same key are greater. */
  readonly revision: number;
  readonly value: unknown;
}

export interface PluginStorageCompareAndSetResult {
  readonly applied: boolean;
  readonly revision?: number;
}

export interface PluginStorageDeleteResult {
  readonly deleted: boolean;
  readonly revision?: number;
}

export interface PluginStorageHost {
  get(key: string): Promise<PluginStorageEntry | undefined>;
  list(): Promise<Readonly<Record<string, PluginStorageEntry>>>;
  set(key: string, value: unknown): Promise<{ readonly revision: number }>;
  compareAndSet(
    key: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<PluginStorageCompareAndSetResult>;
  delete(key: string, expectedRevision?: number): Promise<PluginStorageDeleteResult>;
}

export interface PluginThreadSummary {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface PluginThreadBindingSummary {
  readonly key: string;
  readonly threadId: string;
  readonly createdAt: number;
}

export interface PluginThreadHost {
  get(threadId: string): Promise<PluginThreadSummary | null>;
  create(input: { readonly title: string }): Promise<PluginThreadSummary>;
  update(threadId: string, patch: { readonly title: string }): Promise<PluginThreadSummary>;
  findByKey(key: string): Promise<PluginThreadSummary | null>;
  ensureByKey(key: string, input: { readonly title: string }): Promise<PluginThreadSummary>;
  bind(key: string, threadId: string): Promise<PluginThreadBindingSummary>;
  unbind(key: string): Promise<boolean>;
  listBindings(): Promise<readonly PluginThreadBindingSummary[]>;
  ensureSystemThread(): Promise<PluginThreadSummary>;
}

export type PluginTaskKind = 'work' | 'pr_tracking' | 'issue_tracking';
export type PluginTaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** Minimal stable projection of the Host-owned TaskItem. */
export interface PluginTaskItem {
  readonly id: string;
  readonly kind: PluginTaskKind;
  readonly threadId: string;
  readonly subjectKey: string | null;
  readonly title: string;
  readonly ownerCatId: string | null;
  readonly status: PluginTaskStatus;
  readonly why: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PluginTaskCreateInput {
  readonly threadId: string;
  readonly title: string;
  readonly why?: string;
  readonly kind?: PluginTaskKind;
  readonly subjectKey?: string | null;
  readonly ownerCatId?: string | null;
}

export interface PluginTaskUpdateInput {
  readonly title?: string;
  readonly status?: PluginTaskStatus;
  readonly why?: string;
  readonly ownerCatId?: string | null;
  readonly threadId?: string;
}

export interface PluginTaskHost {
  get(taskId: string): Promise<PluginTaskItem | null>;
  listByThread(threadId: string): Promise<readonly PluginTaskItem[]>;
  listByKind(kind: PluginTaskKind): Promise<readonly PluginTaskItem[]>;
  getBySubject(subjectKey: string): Promise<PluginTaskItem | null>;
  create(input: PluginTaskCreateInput): Promise<PluginTaskItem>;
  upsertBySubject(input: PluginTaskCreateInput): Promise<PluginTaskItem>;
  update(taskId: string, input: PluginTaskUpdateInput): Promise<PluginTaskItem | null>;
  updateIfThreadId(
    taskId: string,
    expectedThreadId: string,
    input: PluginTaskUpdateInput,
  ): Promise<PluginTaskItem | null>;
}

export type PluginMessageContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly alt?: string }
  | {
      readonly type: 'file';
      readonly url: string;
      readonly fileName: string;
      readonly mimeType: string;
      readonly fileSize: number;
    }
  | { readonly type: 'code'; readonly code: string; readonly language?: string; readonly filename?: string }
  | { readonly type: 'tool_call'; readonly toolName: string; readonly toolId: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly toolId: string; readonly result: unknown; readonly isError?: boolean }
  | { readonly type: 'context_attachment'; readonly attachment: unknown };

export type PluginMessagingDraft = Omit<MessageDraft, 'address'> & {
  readonly wake?: 'auto' | { readonly catId: string };
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly contentBlocks?: readonly PluginMessageContent[];
  readonly identity?: string;
  readonly url?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export interface PluginMessagingSubscribeOptions {
  readonly contributionId?: string;
  readonly includeOwnMessages?: boolean;
}

export interface PluginMessagingDelivery {
  readonly deliveryId: string;
  readonly lifecycleId?: string;
  readonly threadId: string;
  readonly envelope: MessageEnvelope;
  readonly presentation?: DeliveryPresentationContext;
}

export interface PluginMediaHost {
  read(input: MediaReadInput): Promise<MediaReadResult>;
}

export interface PluginMessagingHost {
  send(input: PluginMessagingDraft & { readonly threadId: string }): Promise<{
    readonly messageId: string;
    readonly threadId: string;
  }>;
  subscribe(input: {
    readonly threadId: string;
    readonly method: string;
    readonly includeOwnMessages?: boolean;
  }): Promise<void>;
  unsubscribe(input: { readonly threadId: string }): Promise<void>;
}

/** Structural mirror of the Host-owned in-process module surface. */
export interface ModulePluginHostShape {
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly media: PluginMediaHost;
  readonly log: (
    level: ModulePluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface PluginModuleActivationShape {
  readonly actions: Readonly<Record<string, (input: unknown) => unknown | Promise<unknown>>>;
  stop(): void | Promise<void>;
}
