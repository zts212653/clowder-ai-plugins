import type {
  MessageDraft,
} from '@clowder-ai/plugin-contract';
import type {
  PluginTaskDataControllerBindInput,
  PluginTaskDataControllerMutationResult,
  PluginTaskDataControllerRevokeInput,
  PluginTaskDataControllerSummary,
} from './task-data-controller.js';
export type {
  PluginTaskDataControllerBinding,
  PluginTaskDataControllerBindInput,
  PluginTaskDataControllerMutationResult,
  PluginTaskDataControllerRevokeInput,
  PluginTaskDataControllerSummary,
} from './task-data-controller.js';

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
  /** Host-authored navigation after owner/visibility/deleted filtering. Never
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

export interface PluginThreadCreateInput {
  readonly title: string;
  readonly parentThreadId?: string;
  readonly participants?: readonly string[];
}

export interface PluginThreadHost {
  get(threadId: string): Promise<PluginThreadSummary | null>;
  /** Live owner-visible keyset; use the previous page's last position. A short
   * or empty page ends this traversal, not an immutable cross-page snapshot.
   * `threadIds` selects an exact owner-visible candidate set and is mutually
   * exclusive with directory pagination. */
  list(options?: {
    readonly limit?: number;
    readonly before?: { readonly lastActiveAt: number; readonly id: string };
    readonly threadIds?: readonly string[];
  }): Promise<readonly PluginThreadSummary[]>;
  /** Exclusive timeline cursor: timestamp and id must come from the same returned row. */
  readMessages(threadId: string, options: { readonly before?: { readonly timestamp: number; readonly id: string }; readonly limit: number }): Promise<readonly PluginThreadMessage[]>;
  getCats(threadId: string): Promise<PluginThreadCats>;
  addParticipants(input: { readonly threadId: string; readonly catIds: readonly string[] }): Promise<PluginThreadSummary>;
  create(input: PluginThreadCreateInput): Promise<PluginThreadSummary>;
  update(threadId: string, patch: { readonly title?: string; readonly preferredCats?: readonly string[] }): Promise<PluginThreadSummary>;

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
  readonly admission: {
    readonly sourceRefs: readonly string[];
    readonly authorityRef?: string;
    /** Host-verified historical receipt coordinate; read-only and never an execution grant. */
    readonly hostReceipt?: {readonly receiptRef: string; readonly sourceRef: string; readonly catId: string};
  };
  readonly dataController?: PluginTaskDataControllerSummary;
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

interface PluginTaskFieldsPatch {
  readonly entrustedWork?: PluginTaskWorkMutation;
  readonly title?: string;
  readonly status?: PluginTaskStatus;
  readonly why?: string;
  readonly ownerCatId?: string | null;
  readonly threadId?: string;
}

/** Existing canonical Work time representation, projected by the Task owner. */
export type PluginTaskWorkTime = {
  readonly businessDeadline?: {readonly value: number; readonly sourceRef: string};
  readonly reviewBy?: {readonly value: number; readonly sourceRef: string};
  readonly plannedStart?: {readonly value: number; readonly sourceRef: string};
  readonly actualStart?: {readonly value: number; readonly sourceRef: string};
  readonly estimatedCompletion?: {readonly value: number; readonly sourceRef: string};
};
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

/** Exactly one ordinary Task selector. */
export type PluginTaskSelector = {readonly id: string; readonly subjectKey?: never}
  | {readonly subjectKey: string; readonly id?: never};
export interface PluginTaskFilter {
  readonly threadId?: string;
  readonly kind?: PluginTaskKind;
}
export interface PluginTaskCreateOptions {
  /** Defaults to error. Update requires a non-empty subjectKey and preserves Host atomic ensure semantics. */
  readonly onConflict?: 'error' | 'update';
}
export interface PluginTaskUpdateConditions {
  readonly expectedThreadId?: string;
}
/** A wait patch is one atomic update and cannot mix ordinary fields or Work mutations. */
export type PluginTaskUpdateInput = (PluginTaskFieldsPatch & {readonly wait?: never})
  | ({readonly wait: PluginWaitUpdate} & {readonly [K in keyof PluginTaskFieldsPatch]?: never});

export interface PluginTaskHost {
  /** Ordinary data only; Work writes keep their admission grant and do not dispatch execution. */
  get(selector: PluginTaskSelector): Promise<PluginTaskReadItem | null>;
  list(filter: PluginTaskFilter): Promise<readonly PluginTaskReadItem[]>;
  create(input: PluginTaskCreateInput, options?: PluginTaskCreateOptions): Promise<PluginTaskItem>;
  update(taskId: string, patch: PluginTaskUpdateInput, conditions?: PluginTaskUpdateConditions): Promise<PluginTaskItem | null>;
  bindDataController(input: PluginTaskDataControllerBindInput): Promise<PluginTaskDataControllerMutationResult>;
  revokeDataController(input: PluginTaskDataControllerRevokeInput): Promise<PluginTaskDataControllerMutationResult>;
}

/** Raw Host adapter shape. Controller ports are optional only so a new SDK can
 * fail closed with an older Host instead of pretending a fallback exists. */
export type PluginTaskHostAdapter = Omit<PluginTaskHost, 'bindDataController' | 'revokeDataController'> &
  Partial<Pick<PluginTaskHost, 'bindDataController' | 'revokeDataController'>>;

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

/** Current delivery message arm; execution status uses the same declared handler. */
export type PluginMessagingDelivery = import('@clowder-ai/plugin-contract').PluginMessageDelivery;

export interface PluginMessagingHost {
  /** Persistent message facts, subject to ordinary content-read authority. */
  get(messageId: string): Promise<import('./message-read.js').PluginMessage | null>;
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

/** Available while installed, including disabled setup and uninstall. No runtime effects. */
export type ModulePluginSettingsHost = Pick<ModulePluginHostShape, 'pluginInstanceId' | 'dataPath' | 'config' | 'secrets' | 'storage' | 'log'>;

/** Structural mirror of the Host-owned in-process module surface. */
export interface ModulePluginHostShape {
  /** Optional Host-owned seam, supplied only to its verified installed Collective instance. */
  readonly collectiveArtifactOwner?: import('./collective-artifact-owner.js').CollectiveArtifactOwnerPort;
  /** Installation attribution supplied by the Host, never the manifest's package id. */
  readonly pluginInstanceId: string;
  readonly members?: import('./members.js').PluginMemberHost;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHostAdapter;
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly streams: import('./streams.js').PluginStreams;
  /** Stable per-installation storage directory, supplied without a separate grant. */
  readonly dataPath: string;
  readonly log: (
    level: ModulePluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface PluginStopContext { readonly reason: string; }
export interface PluginPreStopContext extends PluginStopContext { /** Absolute Unix milliseconds. */ readonly deadline: number; }

export interface PluginModuleActivationShape {
  readonly streams?: import('./streams.js').PluginStreams;
  configRefresh?(): void | Promise<void>;
  preStop?(context: PluginPreStopContext): void | Promise<void>;
  readonly actions: Readonly<Record<string, import('./feature-context.js').PluginActionHandler>>;
  stop(context: PluginStopContext): void | Promise<void>;
}
