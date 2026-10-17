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
  /** Host-authored navigation after owner/grant/deleted filtering. Never
   * reconstruct this URL from plugin configuration, payloads or thread IDs. */
  readonly deepLinkUrl: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly preferredCats: readonly string[];
  readonly featureRefs: readonly string[];
}

export interface PluginThreadMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly content: string;
  readonly sender: { readonly kind: 'owner' | 'cat' | 'system'; readonly catId?: string };
}

export interface PluginThreadCat {
  readonly catId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
}

export interface PluginThreadCats {
  readonly participants: readonly (PluginThreadCat & {
    readonly lastMessageAt: number;
    readonly messageCount: number;
    readonly lastResponseHealthy?: boolean;
  })[];
  readonly routableNow: readonly PluginThreadCat[];
  readonly routableNotJoined: readonly PluginThreadCat[];
  readonly notRoutable: readonly PluginThreadCat[];
}

export interface PluginThreadBindingSummary {
  readonly key: string;
  readonly threadId: string;
  readonly createdAt: number;
}

export type PluginThreadEnsureInput =
  | { readonly title: string; readonly parentThreadId?: never; readonly participants?: never }
  | { readonly title: string; readonly parentThreadId: string; readonly participants: readonly string[] };

export interface PluginThreadHost {
  get(threadId: string): Promise<PluginThreadSummary | null>;
  /** Live owner-visible keyset; use the previous page's last position. A short
   * or empty page ends this traversal, not an immutable cross-page snapshot. */
  list(options?: { readonly limit?: number; readonly before?: { readonly lastActiveAt: number; readonly id: string } }): Promise<readonly PluginThreadSummary[]>;
  /** Exclusive timeline cursor: timestamp and id must come from the same returned row. */
  readMessages(threadId: string, options: { readonly before?: { readonly timestamp: number; readonly id: string }; readonly limit: number }): Promise<readonly PluginThreadMessage[]>;
  getCats(threadId: string): Promise<PluginThreadCats>;
  create(input: { readonly title: string }): Promise<PluginThreadSummary>;
  update(threadId: string, patch: { readonly title?: string; readonly preferredCats?: readonly string[] }): Promise<PluginThreadSummary>;
  findByKey(key: string): Promise<PluginThreadSummary | null>;
  ensureByKey(key: string, input: PluginThreadEnsureInput): Promise<PluginThreadSummary>;
  bind(key: string, threadId: string): Promise<PluginThreadBindingSummary>;
  unbind(key: string): Promise<boolean>;
  listBindings(): Promise<readonly PluginThreadBindingSummary[]>;
  ensureSystemThread(): Promise<PluginThreadSummary>;
}

export type PluginTaskKind = 'work' | 'pr_tracking' | 'issue_tracking';
export type PluginTaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** Complete neutral wait snapshot; Host supplies instance and invocation identity. */
export interface PluginWaitUpdate {
  readonly expectedGeneration: number | null;
  readonly generation: number;
  readonly active: { readonly expiresAt?: number } | null;
  readonly outcome?: {
    readonly outcomeId: string;
    readonly generation: number;
    readonly ownerFence: { readonly kind: 'containing_task'; readonly generation: number };
    readonly reason: 'matched' | 'subject_terminal' | 'expired' | 'owner_changed' | 'superseded' | 'user_cancel';
    readonly delivery: 'pending' | 'delivered' | 'not_applicable' | 'legacy_unfenced';
  };
}

export interface PluginTaskWait {
  readonly pluginInstanceId: string;
  readonly generation: number;
  readonly await?: { readonly generation: number; readonly expiresAt?: number };
  readonly waitOutcome?: PluginWaitUpdate['outcome'];
}

/** Minimal stable projection of the Host-owned TaskItem. */
export interface PluginTaskItem {
  readonly pluginWait?: PluginTaskWait;
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

/** Read-only owner/source summary. It is never a Task admission or execution grant. */
export interface PluginTaskEntrustedWorkSummary {
  readonly revision: number;
  readonly time?: PluginTaskWorkTime;
  readonly artifactRefs?: readonly string[];
  readonly closure: { readonly state: string };
  readonly admission: { readonly sourceRefs: readonly string[] };
}

/** All Task reads explicitly distinguish an unowned legacy Task from an absent projection. */
export interface PluginTaskReadItem extends PluginTaskItem {
  readonly userId: string | null;
  readonly entrustedWork?: PluginTaskEntrustedWorkSummary;
}

export interface PluginTaskCreateInput {
  /** Original Task/Schedule data; does not prepare or dispatch an execution. */
  readonly entrustedWork?: PluginTaskWorkData;
  readonly threadId: string;
  readonly title: string;
  readonly why?: string;
  readonly kind?: PluginTaskKind;
  readonly subjectKey?: string | null;
  readonly ownerCatId?: string | null;
}

export interface PluginTaskUpdateInput {
  readonly entrustedWork?: PluginTaskWorkMutation;
  readonly title?: string;
  readonly status?: PluginTaskStatus;
  readonly why?: string;
  readonly ownerCatId?: string | null;
  readonly threadId?: string;
}

/** Existing canonical Work time representation, projected by the Task owner. */
export type PluginTaskWorkTime = NonNullable<Extract<import('@clowder-ai/plugin-contract').PluginTaskAdmissionInput['subject'], {kind: 'new'}>['time']>;
export interface PluginTaskWorkData {
  readonly sourceMessageId: string;
  readonly intendedOutcome: string;
  readonly closure: {readonly condition: string; readonly expectedSignal: string};
  readonly time?: PluginTaskWorkTime;
}
export type PluginTaskWorkMutation = {
  readonly expectedRevision: number;
  readonly artifactRefs?: readonly string[];
  readonly time?: {readonly [K in keyof PluginTaskWorkTime]?: PluginTaskWorkTime[K] | null};
  readonly progress?: {readonly summary: string; readonly nextStep?: string; readonly blockerReason?: string; readonly sourceRef: string} | null;
} | {
  readonly expectedRevision: number;
  readonly closure: {readonly state: 'satisfied'; readonly condition: string; readonly expectedSignal: string; readonly evidenceRefs: readonly string[]}
    | {readonly state: 'cancelled' | 'abandoned'; readonly condition: string; readonly expectedSignal: string; readonly evidenceRefs: readonly string[];
      readonly disposition: {readonly kind: 'cancelled' | 'abandoned'; readonly actorKind: 'human' | 'owner'; readonly actorRef: string;
        readonly authorityRef: string; readonly dispositionRef: string; readonly disposedAt: number}};
};

export interface PluginTaskHost {
  /** Prepare Host-owned Task/receipt or queue that exact prepared execution; absent on older carriers. */
  prepareEntrusted?(input: import('@clowder-ai/plugin-contract').PluginTaskAdmissionInput): Promise<import('@clowder-ai/plugin-contract').PluginTaskAdmissionResult>;
  dispatchEntrusted?(input: import('@clowder-ai/plugin-contract').PluginTaskDispatchInput): Promise<import('@clowder-ai/plugin-contract').PluginTaskDispatchResult>;
  setWait(taskId: string, input: PluginWaitUpdate): Promise<PluginTaskItem | null>;
  get(taskId: string): Promise<PluginTaskReadItem | null>;
  listByThread(threadId: string): Promise<readonly PluginTaskReadItem[]>;
  listByKind(kind: PluginTaskKind): Promise<readonly PluginTaskReadItem[]>;
  getBySubject(subjectKey: string): Promise<PluginTaskReadItem | null>;
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
  /** Optional only for legacy carriers; real persistent facts, no callback authority. */
  get?(messageId: string): Promise<import('./message-read.js').PluginMessage | null>;
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
  /** Installation attribution supplied by the Host, never the manifest's package id. */
  readonly pluginInstanceId: string;
  /** Optional on older carriers; Host-owned admission of a persisted public source. */
  readonly publicInvocations?: import('./public-invocations.js').PluginPublicInvocationHost;
  readonly sourceFacts?: import('./source-facts.js').PluginSourceFactsHost;
  readonly nativeContext?: import('./source-facts.js').PluginNativeContextHost;
  readonly participantRoster?: import('./participant-roster.js').PluginParticipantRosterHost;
  /** Optional on older carriers; present only as the complete strict owner port. */
  readonly ownerThreads?: import('./owner-threads.js').PluginOwnerThreadHost;
  readonly browserServices?: import('./browser-services.js').BrowserServiceHost;
  readonly frustration?: import('./frustration.js').PluginFrustrationHost;
  readonly deployment?: import('./deployment.js').PluginDeploymentHost;
  readonly custody?: import('./custody.js').PluginCustodyHost;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly media: PluginMediaHost;
  /** Host-provisioned absolute path, present only when data.directory is granted. */
  readonly dataDirectory?: string;
  readonly log: (
    level: ModulePluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface PluginModuleActivationShape {
  readonly publicInvocationVerifier?: import('./public-invocation-verifier.js').PluginPublicInvocationVerifier;
  readonly predicateVerifiers?: Readonly<Record<string, import('./custody.js').PluginPredicateVerifier>>;
  readonly actions: Readonly<Record<string, import('./feature-context.js').PluginActionHandler>>;
  stop(): void | Promise<void>;
}
