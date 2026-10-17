import { projectTaskRead, projectTaskReadList } from './task-read.js';
import { capturePublicInvocationVerifier, guardPublicInvocationVerifier, PUBLIC_INVOCATION_VERIFIER_METHOD, type PluginPublicInvocationVerifier } from './public-invocation-verifier.js';
import { createSourceFactsClient, createNativeContextClient, type PluginSourceFactsHost, type PluginNativeContextHost,
  type PluginNativeContextClient } from './source-facts.js';
import { createEntrustedTaskClient } from './task-entrusted.js';
import { createMessageReader, type PluginMessage } from './message-read.js';
import { createParticipantRosterClient, type PluginParticipantRosterHost, type PluginParticipantRosterClient } from './participant-roster.js';
import { createPublicInvocationClient, type PluginPublicInvocationHost } from './public-invocations.js';
import type { BrowserServiceHost, PluginHostActionContext } from './browser-services.js';
import { createFrustrationClient, type PluginFrustrationHost } from './frustration.js';
import { createDeploymentClient, type PluginDeploymentHost } from './deployment.js';
import { createOwnerThreadClient, type PluginOwnerThreadHost } from './owner-threads.js';
import { createCustodyClient, guardPredicateVerifier, type PluginCustodyHost, type PluginPredicateVerifier } from './custody.js';
import {
  validateManifest,
  type Capability,
  type BrowserServiceContribution,
  type CloudConversationHostContribution,
  type ContentEditorProviderContribution,
  type DirectToolContribution,
  type DesktopWindowContribution,
  type IdentityContribution,
  type LimbContribution,
  type McpContribution,
  type MessageSubscriptionContribution,
  type MediaReadInput,
  type MediaReadResult,
  type MediaSourceContribution,
  type PluginManifest,
  type ScheduleContribution,
  type ServiceContribution,
  type SkillContribution,
  type StaticContribution,
  type UiContribution,
  type WebhookContribution,
} from '@clowder-ai/plugin-contract';
import type {
  ModulePluginLogLevel,
  PluginMessagingDraft,
  PluginMessagingHost,
  PluginMessagingSubscribeOptions,
  PluginStorageHost,
  PluginTaskHost,
  PluginThreadHost,
} from './module-host.js';
import { createMediaReader, type PluginMediaReader } from './p1-runtime.js';

export interface FeatureBinding {
  readonly pluginInstanceId: string;
  readonly featureId: string;
  readonly packageRevision: string;
  readonly integrityEpoch: number;
  readonly activationRevision: number;
  readonly grantRevision: number;
  readonly grantedCapabilities: readonly Capability[];
  /**
   * Absolute path of the Host-provisioned data directory. Present only when the
   * owning feature is granted the data.directory capability and the manifest
   * declares runtime.dataDirectory.
   */
  readonly dataDirectory?: string;
  /** Opaque Host-issued authority. SDK code transports it but never interprets it. */
  readonly executionLease: string;
}

export interface HostContributionReceipt {
  readonly registrationId: string;
  readonly registryRevision: number;
}

export type PluginLogLevel = ModulePluginLogLevel;

export interface FeatureHostAdapter {
  getMessage?(messageId: string): Promise<PluginMessage | null>;
  readonly publicInvocations?: PluginPublicInvocationHost;
  /** Exact authenticated source subset; absent on older carriers. */
  readonly sourceFacts?: PluginSourceFactsHost;
  /** Verified native invocation; Task facts require explicit opt-in and task.read, never body identity. */
  readonly nativeContext?: PluginNativeContextHost;
  /** Current owner or same-owner verified native invocation; absent on older carriers. */
  readonly participantRoster?: PluginParticipantRosterHost;
  readonly ownerThreads?: PluginOwnerThreadHost;
  readonly browserServices?: BrowserServiceHost;
  readonly frustration?: PluginFrustrationHost;
  readonly deployment?: PluginDeploymentHost;
  readonly custody?: PluginCustodyHost;
  readConfig(binding: FeatureBinding, key: string): Promise<unknown>;
  readSecret(binding: FeatureBinding, key: string): Promise<string | undefined>;
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  registerContribution(
    binding: FeatureBinding,
    contribution: StaticContribution,
  ): Promise<HostContributionReceipt>;
  disposeContribution(binding: FeatureBinding, receipt: HostContributionReceipt): Promise<void>;
  sendMessage(
    binding: FeatureBinding,
    threadId: string,
    input: PluginMessagingDraft,
  ): ReturnType<PluginMessagingHost['send']>;
  subscribeMessage(
    binding: FeatureBinding,
    input: Parameters<PluginMessagingHost['subscribe']>[0],
  ): ReturnType<PluginMessagingHost['subscribe']>;
  unsubscribeMessage(
    binding: FeatureBinding,
    input: Parameters<PluginMessagingHost['unsubscribe']>[0],
  ): ReturnType<PluginMessagingHost['unsubscribe']>;
  readMedia(
    binding: FeatureBinding,
    input: MediaReadInput,
  ): Promise<MediaReadResult>;
  log(
    binding: FeatureBinding,
    level: PluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

export class FeatureContextRevokedError extends Error {
  constructor() {
    super('feature context has been revoked');
    this.name = 'FeatureContextRevokedError';
  }
}

export class ContributionConflictError extends Error {
  constructor(key: string) {
    super(`contribution ${key} is already registered with a different payload`);
    this.name = 'ContributionConflictError';
  }
}

export class FeaturePermissionError extends Error {
  readonly code = 'PERMISSION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FeaturePermissionError';
  }
}

export interface ContributionRegistration {
  readonly key: string;
  readonly receipt: HostContributionReceipt;
  dispose(): Promise<void>;
}

type RegistrationInput<T extends StaticContribution> = T extends unknown ? Omit<T, 'type'> : never;

export interface ContributionRegistrar<T extends StaticContribution> {
  register(input: RegistrationInput<T>): Promise<ContributionRegistration>;
}

export interface FeatureContext {
  /** Host installation attribution. This id grants no operation or business authority. */
  readonly pluginInstanceId: string;
  /** Persist source first, save business mapping, then admit through Host Queue; absent on older carriers. */
  readonly publicInvocations?: PluginPublicInvocationHost;
  /** Exact authenticated source subset; absent on older carriers. */
  readonly sourceFacts?: PluginSourceFactsHost;
  /** Verified native invocation; Task facts require explicit opt-in and task.read, never body identity. */
  readonly nativeContext?: PluginNativeContextClient;
  /** Current owner or same-owner verified native invocation; absent on older carriers. */
  readonly participantRoster?: PluginParticipantRosterClient;
  /** Strict authenticated owner webhook calls only; absent on older carriers. */
  readonly ownerThreads?: PluginOwnerThreadHost;
  readonly browserServices?: BrowserServiceHost;
  readonly frustration: PluginFrustrationHost;
  readonly deployment: PluginDeploymentHost;
  readonly custody: PluginCustodyHost;
  readonly featureId: string;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  /** @deprecated Use storage. Retained for one SDK beta as the same object. */
  readonly state: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  readonly identity: ContributionRegistrar<IdentityContribution>;
  readonly scheduler: ContributionRegistrar<ScheduleContribution>;
  readonly tools: ContributionRegistrar<DirectToolContribution>;
  readonly mcp: ContributionRegistrar<McpContribution>;
  readonly skills: ContributionRegistrar<SkillContribution>;
  readonly limbs: ContributionRegistrar<LimbContribution>;
  readonly webhooks: ContributionRegistrar<WebhookContribution>;
  readonly messaging: {
    readonly get?: (messageId: string) => Promise<PluginMessage | null>;
    readonly subscribe: (
      threadId: string,
      options?: PluginMessagingSubscribeOptions,
    ) => Promise<void>;
    readonly unsubscribe: (threadId: string) => Promise<void>;
    readonly send: (
      threadId: string,
      input: PluginMessagingDraft,
    ) => ReturnType<PluginMessagingHost['send']>;
  };
  readonly media: PluginMediaReader;
  readonly mediaSources: ContributionRegistrar<MediaSourceContribution>;
  readonly services: ContributionRegistrar<ServiceContribution>;
  readonly conversationHosts: ContributionRegistrar<CloudConversationHostContribution>;
  /**
   * Host-provisioned data directory. Reading it without the data.directory
   * capability throws FeaturePermissionError with code 'PERMISSION'.
   */
  readonly dataDirectory: string;
  readonly log: (
    level: PluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
  /** @deprecated Use log. */
  readonly logger: Readonly<Record<PluginLogLevel, (...args: readonly unknown[]) => void>>;
  readonly ui: ContributionRegistrar<UiContribution>;
  readonly contentEditors: ContributionRegistrar<ContentEditorProviderContribution>;
  readonly windows: ContributionRegistrar<DesktopWindowContribution>;
}

export interface FeatureContextSession {
  readonly context: FeatureContext;
  revoke(): Promise<void>;
}

export interface FeatureContextSessionOptions {
  readonly messageSubscriptions?: readonly MessageSubscriptionContribution[];
  readonly browserServices?: readonly BrowserServiceContribution[];
}

interface ActiveRegistration {
  readonly digest: string;
  readonly promise: Promise<ContributionRegistration>;
  disposePromise?: Promise<void>;
}

/** @internal Stable JSON identity shared by contribution validation and module startup. */
export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('contribution payload must contain only JSON values');
  if (ancestors.has(value)) throw new TypeError('contribution payload must not contain JSON cycles');
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('contribution payload must contain only JSON string keys');
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('contribution payload must contain only plain JSON objects or arrays');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError('contribution payload must contain only JSON array elements');
      }
      const elements: string[] = [];
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('contribution payload must not contain JSON array holes');
        elements.push(canonicalJson(value[index], ancestors));
      }
      return `[${elements.join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Creates the author-facing context around a Host-issued binding.
 *
 * This helper does not grant authority: every adapter operation carries the opaque lease and the Host
 * remains responsible for verifying its signature, revisions, grants, integrity epoch, and liveness.
 */
export function createFeatureContextSession(
  binding: FeatureBinding,
  adapter: FeatureHostAdapter,
  options: FeatureContextSessionOptions = {},
): FeatureContextSession {
  let revoked = false;
  let revokePromise: Promise<void> | undefined;
  const active = new Map<string, ActiveRegistration>();

  const assertActive = (): void => {
    if (revoked) throw new FeatureContextRevokedError();
  };

  const register = async <T extends StaticContribution>(
    type: T['type'],
    input: RegistrationInput<T>,
  ): Promise<ContributionRegistration> => {
    assertActive();
    const digest = canonicalJson({ ...input, type });
    // Dispatch exactly the JSON snapshot used for identity; cloning first can
    // silently erase non-JSON keys, while reading twice can invoke changing getters.
    const contribution = deepFreeze(JSON.parse(digest)) as unknown as T;
    const key = `${type}:${contribution.id}`;
    const existing = active.get(key);
    if (existing !== undefined) {
      if (existing.disposePromise !== undefined) {
        await existing.disposePromise.catch(() => undefined);
        assertActive();
        return register<T>(type, input);
      }
      if (existing.digest !== digest) throw new ContributionConflictError(key);
      const registration = await existing.promise;
      if (revoked) {
        await registration.dispose().catch(() => undefined);
        throw new FeatureContextRevokedError();
      }
      return registration;
    }

    let entry: ActiveRegistration;
    const promise = adapter.registerContribution(binding, contribution).then((receipt) => {
      const registration: ContributionRegistration = {
        key,
        receipt,
        dispose: () => {
          if (entry.disposePromise !== undefined) return entry.disposePromise;
          entry.disposePromise = adapter.disposeContribution(binding, receipt).then(
            () => {
              if (active.get(key) === entry) active.delete(key);
            },
            (error: unknown) => {
              entry.disposePromise = undefined;
              throw error;
            },
          );
          return entry.disposePromise;
        },
      };
      return registration;
    });
    entry = { digest, promise };
    active.set(key, entry);
    let registered = false;
    try {
      const registration = await promise;
      registered = true;
      if (revoked) {
        await registration.dispose().catch(() => undefined);
        throw new FeatureContextRevokedError();
      }
      return registration;
    } catch (error) {
      if (!registered && active.get(key) === entry) active.delete(key);
      throw error;
    }
  };

  const registrar = <T extends StaticContribution>(type: T['type']): ContributionRegistrar<T> => ({
    register: (input) => register<T>(type, input),
  });

  const runWhileActive = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    const result = await operation();
    assertActive();
    return result;
  };

  const readConfig = async (key: string): Promise<unknown> => {
    return runWhileActive(() => adapter.readConfig(binding, key));
  };
  const readSecret = async (key: string): Promise<string | undefined> => {
    return runWhileActive(() => adapter.readSecret(binding, key));
  };

  const storage: PluginStorageHost = {
    get: (key) => runWhileActive(() => adapter.storage.get(key)),
    list: () => runWhileActive(() => adapter.storage.list()),
    set: (key, value) => runWhileActive(() => adapter.storage.set(key, value)),
    compareAndSet: (key, expectedRevision, value) =>
      runWhileActive(() => adapter.storage.compareAndSet(key, expectedRevision, value)),
    delete: (key, expectedRevision) =>
      runWhileActive(() => adapter.storage.delete(key, expectedRevision)),
  };
  const tasks: PluginTaskHost = {
    ...(adapter.tasks ? createEntrustedTaskClient(adapter.tasks, () => {
      assertActive();
      if (!binding.grantedCapabilities.includes('task.admitEntrusted')) throw new FeaturePermissionError('task.admitEntrusted not granted');
    }) : {}),
    setWait: (taskId, input) => runWhileActive(() => adapter.tasks.setWait(taskId, input)),
    get: (taskId) => runWhileActive(async () => projectTaskRead(await adapter.tasks.get(taskId))),
    listByThread: (threadId) => runWhileActive(async () => projectTaskReadList(await adapter.tasks.listByThread(threadId))),
    listByKind: (kind) => runWhileActive(async () => projectTaskReadList(await adapter.tasks.listByKind(kind))),
    getBySubject: (subjectKey) => runWhileActive(async () => projectTaskRead(await adapter.tasks.getBySubject(subjectKey))),
    create: (input) => runWhileActive(() => adapter.tasks.create(input)),
    upsertBySubject: (input) => runWhileActive(() => adapter.tasks.upsertBySubject(input)),
    update: (taskId, input) => runWhileActive(() => adapter.tasks.update(taskId, input)),
    updateIfThreadId: (taskId, expectedThreadId, input) =>
      runWhileActive(() => adapter.tasks.updateIfThreadId(taskId, expectedThreadId, input)),
  };
  const frustration = createFrustrationClient(adapter.frustration, needed => {
    assertActive();
    for (const capability of needed) if (!binding.grantedCapabilities.includes(capability)) throw new Error(`${capability} not granted`);
  });
  const deployment = createDeploymentClient(adapter.deployment, () => {
    assertActive();
    if (!binding.grantedCapabilities.includes('deployment.read')) throw new Error('deployment.read not granted');
  });
  const custody = createCustodyClient(adapter.custody, () => {
    assertActive();
    if (!binding.grantedCapabilities.includes('custody.invoke')) throw new Error('custody.invoke not granted');
  });
  const threads: PluginThreadHost = {
    get: (threadId) => runWhileActive(() => adapter.threads.get(threadId)),
    list: (options) => runWhileActive(() => adapter.threads.list(options)),
    readMessages: (threadId, options) => runWhileActive(() => adapter.threads.readMessages(threadId, options)),
    getCats: (threadId) => runWhileActive(() => adapter.threads.getCats(threadId)),
    create: (input) => runWhileActive(() => adapter.threads.create(input)),
    update: (threadId, patch) => runWhileActive(() => adapter.threads.update(threadId, patch)),
    findByKey: (key) => runWhileActive(() => adapter.threads.findByKey(key)),
    ensureByKey: (key, input) => runWhileActive(() => adapter.threads.ensureByKey(key, input)),
    bind: (key, threadId) => runWhileActive(() => adapter.threads.bind(key, threadId)),
    unbind: (key) => runWhileActive(() => adapter.threads.unbind(key)),
    listBindings: () => runWhileActive(() => adapter.threads.listBindings()),
    ensureSystemThread: () => runWhileActive(() => adapter.threads.ensureSystemThread()),
  };
  const assertContentAccess = () => {
    assertActive();
    if (!binding.grantedCapabilities.includes('thread.readContent')) throw new FeaturePermissionError('thread.readContent not granted');
  };
  const sourceFacts = adapter.sourceFacts === undefined ? undefined : createSourceFactsClient(adapter.sourceFacts, assertContentAccess);
  const getMessage = adapter.getMessage === undefined ? undefined : createMessageReader(adapter.getMessage.bind(adapter), assertContentAccess);
  const publicInvocations = adapter.publicInvocations === undefined ? undefined : createPublicInvocationClient(adapter.publicInvocations, () => {
    assertContentAccess();
    if (!binding.grantedCapabilities.includes('messaging.send')) throw new FeaturePermissionError('messaging.send not granted');
  });
  const nativeContext = adapter.nativeContext === undefined ? undefined : createNativeContextClient(adapter.nativeContext, assertContentAccess, () => {
    assertActive();
    if (!binding.grantedCapabilities.includes('task.read')) throw new FeaturePermissionError('task.read not granted');
  });
  const participantRoster = adapter.participantRoster === undefined ? undefined : createParticipantRosterClient(adapter.participantRoster, assertActive);
  const ownerThreads = adapter.ownerThreads === undefined ? undefined : createOwnerThreadClient(adapter.ownerThreads, capability => {
    assertActive();
    if (!binding.grantedCapabilities.includes(capability)) throw new FeaturePermissionError(`${capability} not granted`);
  });
  const sendMessage = (threadId: string, input: PluginMessagingDraft) =>
    runWhileActive(() => adapter.sendMessage(binding, threadId, input));
  const subscribeMessage = (
    threadId: string,
    subscriptionOptions: PluginMessagingSubscribeOptions = {},
  ): Promise<void> => {
    const candidates = options.messageSubscriptions ?? [];
    const contribution = subscriptionOptions.contributionId === undefined
      ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find((candidate) => candidate.id === subscriptionOptions.contributionId);
    if (contribution === undefined) {
      const reason = candidates.length === 0
        ? 'feature declares no message-subscription contribution'
        : subscriptionOptions.contributionId === undefined
          ? 'feature declares multiple message-subscription contributions; contributionId is required'
          : `message-subscription ${subscriptionOptions.contributionId} is not declared by this feature`;
      return Promise.reject(new TypeError(reason));
    }
    return runWhileActive(() => adapter.subscribeMessage(binding, {
      threadId,
      method: contribution.action.method,
      ...(subscriptionOptions.includeOwnMessages === undefined
        ? {}
        : { includeOwnMessages: subscriptionOptions.includeOwnMessages }),
    }));
  };
  const unsubscribeMessage = (threadId: string): Promise<void> =>
    runWhileActive(() => adapter.unsubscribeMessage(binding, { threadId }));
  const media = createMediaReader(input => runWhileActive(() => adapter.readMedia(binding, input)));

  const log = (
    level: PluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    assertActive();
    adapter.log(binding, level, message, fields);
  };

  const browserServiceIds = new Set((options.browserServices ?? []).map(item => item.id));
  const browserServices: BrowserServiceHost | undefined = adapter.browserServices ? {
    getBinding: contributionId => runWhileActive(async () => {
      if (!browserServiceIds.has(contributionId)) throw new FeaturePermissionError('browser-service is not owned by this feature');
      const hostBinding = await adapter.browserServices!.getBinding(contributionId);
      if (hostBinding.contributionId !== contributionId) throw new FeaturePermissionError('browser-service binding mismatch');
      await hostBinding.assertCurrent();
      return Object.freeze({ ...hostBinding, assertCurrent: () => runWhileActive(() => hostBinding.assertCurrent()) });
    }),
    dispatchLocal: (contributionId, request, call) => runWhileActive(() => {
      if (!browserServiceIds.has(contributionId)) throw new FeaturePermissionError('browser-service is not owned by this feature');
      return adapter.browserServices!.dispatchLocal(contributionId, request, call);
    }),
  } : undefined;
  const context: FeatureContext = {
    get pluginInstanceId() {
      assertActive();
      if (typeof binding.pluginInstanceId !== 'string' || !binding.pluginInstanceId.trim())
        throw new TypeError('Host installed plugin instance id is unavailable');
      return binding.pluginInstanceId;
    },
    ...(publicInvocations ? { publicInvocations } : {}),
    ...(sourceFacts ? { sourceFacts } : {}),
    ...(nativeContext ? { nativeContext } : {}),
    ...(participantRoster ? { participantRoster } : {}),
    ...(ownerThreads ? { ownerThreads } : {}),
    ...(browserServices ? { browserServices } : {}),
    featureId: binding.featureId,
    config: { get: readConfig },
    secrets: { get: readSecret },
    storage,
    state: storage,
    tasks,
    threads,
    custody,
    deployment,
    frustration,
    identity: registrar<IdentityContribution>('identity'),
    scheduler: registrar<ScheduleContribution>('schedule'),
    tools: registrar<DirectToolContribution>('tool'),
    mcp: registrar<McpContribution>('mcp'),
    skills: registrar<SkillContribution>('skill'),
    limbs: registrar<LimbContribution>('limb'),
    webhooks: registrar<WebhookContribution>('webhook'),
    messaging: { ...(getMessage ? { get: getMessage } : {}), subscribe: subscribeMessage, unsubscribe: unsubscribeMessage, send: sendMessage },
    media,
    mediaSources: registrar<MediaSourceContribution>('media-source'),
    services: registrar<ServiceContribution>('service'),
    conversationHosts: registrar<CloudConversationHostContribution>('cloud-conversation-host'),
    get dataDirectory(): string {
      assertActive();
      if (
        !binding.grantedCapabilities.includes('data.directory')
        || binding.dataDirectory === undefined
      ) {
        throw new FeaturePermissionError(
          'feature has no data directory: grant the data.directory capability and declare runtime.dataDirectory',
        );
      }
      return binding.dataDirectory;
    },
    log,
    logger: {
      debug: (...args) => log('debug', String(args[0]), args[1] as Readonly<Record<string, unknown>> | undefined),
      info: (...args) => log('info', String(args[0]), args[1] as Readonly<Record<string, unknown>> | undefined),
      warn: (...args) => log('warn', String(args[0]), args[1] as Readonly<Record<string, unknown>> | undefined),
      error: (...args) => log('error', String(args[0]), args[1] as Readonly<Record<string, unknown>> | undefined),
    },
    ui: registrar<UiContribution>('ui'),
    contentEditors: registrar<ContentEditorProviderContribution>('content-editor-provider'),
    windows: registrar<DesktopWindowContribution>('desktop-window'),
  };

  return {
    context,
    revoke: () => {
      revoked = true;
      if (revokePromise !== undefined) return revokePromise;
      revokePromise = Promise.all(
        [...active.values()].map(async (entry) => (await entry.promise).dispose()),
      ).then(
        () => undefined,
        (error: unknown) => {
          revokePromise = undefined;
          throw error;
        },
      );
      return revokePromise;
    },
  };
}

export type PluginActionHandler = (input: unknown, context?: import('./module-action-client.js').PluginActionContext, hostContext?: PluginHostActionContext) => unknown | Promise<unknown>;

export interface FeatureActivation {
  readonly publicInvocationVerifier?: PluginPublicInvocationVerifier;
  readonly predicateVerifiers?: Readonly<Record<string, PluginPredicateVerifier>>;
  readonly actions?: Readonly<Record<string, PluginActionHandler>>;
  dispose?(): void | Promise<void>;
}

export type FeatureActivator = (
  context: FeatureContext,
) => void | FeatureActivation | Promise<void | FeatureActivation>;

export interface PluginDefinitionInput {
  readonly manifest: unknown;
  readonly activate?: Readonly<Record<string, FeatureActivator>>;
}

export interface DefinedPlugin {
  readonly manifest: PluginManifest;
  readonly activate: Readonly<Record<string, FeatureActivator>>;
}

export interface ActivePluginFeature {
  readonly publicInvocationVerifier?: PluginPublicInvocationVerifier;
  readonly predicateVerifiers: Readonly<Record<string, PluginPredicateVerifier>>;
  readonly actions: Readonly<Record<string, PluginActionHandler>>;
  dispose(): Promise<void>;
}

export interface ActivePluginFeatureOptions {
  /** CallbackAction methods declared outside a feature contribution (operation/test). */
  readonly additionalMethods?: ReadonlySet<string>;
  /** Limb handler names live in limb YAML, so the SDK passes extra handlers through. */
  readonly allowLimbHandlers?: boolean;
}

function actionMethods(contribution: StaticContribution): readonly string[] {
  switch (contribution.type) {
    case 'mcp':
      return (contribution.actions ?? []).map(action => action.method);
    case 'schedule':
    case 'tool':
    case 'webhook':
    case 'browser-service':
      return [contribution.action.method];
    case 'message-subscription':
      return [
        contribution.action.method,
        ...(contribution.lifecycleAction === undefined ? [] : [contribution.lifecycleAction.method]),
      ];
    case 'media-source':
      return [contribution.readAction.method, contribution.settleAction.method];
    case 'service':
      return [contribution.healthMethod];
    case 'cloud-conversation-host':
      return [
        contribution.appendMessage.method,
        contribution.assistantReturns.list.method,
        contribution.assistantReturns.ack.method,
      ];
    case 'ui':
      return contribution.kind === 'command' ? [contribution.action.method] : [];
    default:
      return [];
  }
}

export function featureActionMethods(manifest: PluginManifest, featureId: string): ReadonlySet<string> {
  const feature = manifest.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) throw new TypeError(`feature ${featureId} is not declared by the plugin manifest`);
  const keys = new Set((feature.contributions ?? []).map((item) => `${item.type}:${item.id}`));
  return new Set(
    (manifest.contributions ?? [])
      .filter((contribution) => keys.has(`${contribution.type}:${contribution.id}`))
      .flatMap(actionMethods),
  );
}

/** Activate one Host-authorized feature and close its method/disposal surface. */
export async function activateDefinedFeature(
  plugin: DefinedPlugin,
  featureId: string,
  context: FeatureContext,
  options: ActivePluginFeatureOptions = {},
): Promise<ActivePluginFeature> {
  if (context.featureId !== featureId) {
    throw new TypeError(`feature context ${context.featureId} cannot activate ${featureId}`);
  }
  const activate = plugin.activate[featureId];
  if (activate === undefined) {
    throw new TypeError(`feature ${featureId} has no package activator`);
  }
  const result = await activate(context);
  const activation = result ?? {};
  const disposeActivation = activation.dispose ?? (() => undefined);
  const rawActions = Object.freeze({ ...(activation.actions ?? {}) });
  const actions = rawActions;
  let publicVerifier: PluginPublicInvocationVerifier | undefined;
  try {
    if (Object.hasOwn(actions, PUBLIC_INVOCATION_VERIFIER_METHOD) || plugin.manifest.contributions?.some(
      contribution => contribution.type === 'mcp' && contribution.actions?.some(action => action.method === PUBLIC_INVOCATION_VERIFIER_METHOD),
    )) throw new TypeError('Public verifier cannot be an ordinary action');
    publicVerifier = capturePublicInvocationVerifier(activation);
  } catch (error) { await Promise.resolve(disposeActivation()).catch(() => undefined); throw error; }

  const requiredMethods = featureActionMethods(plugin.manifest, featureId);
  const allowedMethods = new Set(requiredMethods);
  for (const method of options.additionalMethods ?? []) allowedMethods.add(method);
  const undeclared = options.allowLimbHandlers === true
    ? undefined
    : Object.keys(actions).find((method) => !allowedMethods.has(method));
  if (undeclared !== undefined) {
    await Promise.resolve(disposeActivation()).catch(() => undefined);
    throw new TypeError(`action handler ${undeclared} is not declared by feature ${featureId}`);
  }
  const missing = [...requiredMethods].find((method) => actions[method] === undefined);
  if (missing !== undefined) {
    await Promise.resolve(disposeActivation()).catch(() => undefined);
    throw new TypeError(`declared action ${missing} has no handler for feature ${featureId}`);
  }
  let disposed = false;
  const verifierLifetime = new AbortController();
  const publicInvocationVerifier = publicVerifier === undefined ? undefined : guardPublicInvocationVerifier(publicVerifier,
    verifierLifetime.signal, () => { if (disposed) throw new FeatureContextRevokedError(); });
  const declared = (plugin.manifest.contributions ?? []).filter(c => c.type === 'terminal-predicate-provider' &&
    plugin.manifest.features.find(f => f.id === featureId)?.contributions?.some(r => r.type === c.type && r.id === c.id));
  const expected = new Map<string, 'freshness' | 'completion'>();
  for (const c of declared) if (c.type === 'terminal-predicate-provider') {
    expected.set(c.freshnessMethod, 'freshness'); expected.set(c.completionMethod, 'completion');
  }
  const provided = activation.predicateVerifiers ?? {};
  const invalid = [...expected.keys()].some(method => !Object.hasOwn(provided, method) || typeof provided[method] !== 'function') ||
    Object.keys(provided).some(method => !expected.has(method) || typeof provided[method] !== 'function' || Object.hasOwn(actions, method));
  if (invalid) { await Promise.resolve(disposeActivation()).catch(() => undefined); throw new TypeError('predicate verifier handlers must exactly match feature declarations'); }
  const predicateVerifiers = Object.freeze(Object.fromEntries([...expected].map(([method, phase]) => [method,
    guardPredicateVerifier(phase, provided[method]!, () => { if (disposed) throw new FeatureContextRevokedError(); }),
  ])));
  const httpMethods = new Map((plugin.manifest.contributions ?? []).filter(
    (contribution): contribution is BrowserServiceContribution => contribution.type === 'browser-service',
  ).map(contribution => [contribution.action.method, contribution.id]));
  const ownerWebhooks = (plugin.manifest.contributions ?? []).filter(
    (contribution): contribution is WebhookContribution => contribution.type === 'webhook',
  );
  const guardedActions = Object.freeze(Object.fromEntries(Object.entries(actions).map(([method, handler]) => [method,
    async (input: unknown, nativeContext?: import('./module-action-client.js').PluginActionContext, hostContext?: PluginHostActionContext) => {
      const assertCall = async () => {
        if (disposed) throw new FeatureContextRevokedError();
        if (hostContext && (hostContext.kind !== 'http' && hostContext.kind !== 'owner-operation' && hostContext.kind !== 'owner-http-request'))
          throw new FeaturePermissionError('unknown Host action context');
        if (httpMethods.has(method)) {
          if (nativeContext !== undefined || hostContext?.kind !== 'http' || hostContext.contributionId !== httpMethods.get(method) ||
            !['browser', 'local'].includes(hostContext.lane) || !hostContext.requestId)
            throw new FeaturePermissionError('private browser-service action requires its exact HTTP context');
        } else if (hostContext?.kind === 'http') throw new FeaturePermissionError('HTTP context cannot invoke ordinary actions');
        if (hostContext?.kind === 'owner-http-request') {
          if (nativeContext !== undefined || !hostContext.userId || !hostContext.pluginInstanceId ||
            !['read', 'write'].includes(hostContext.operation))
            throw new FeaturePermissionError('owner HTTP caller is invalid');
          const request = hostContext.requestIdentity;
          if (!ownerWebhooks.some(webhook => webhook.action.method === method &&
            (request === undefined || webhook.id === request.contributionId && webhook.path === request.declaredPath &&
              webhook.methods.some(verb => verb === request.method))))
            throw new FeaturePermissionError('owner HTTP call does not match its declared webhook');
          if (request && (request.kind !== 'owner_http' || !request.requestId ||
            request.userId !== hostContext.userId || request.pluginInstanceId !== hostContext.pluginInstanceId ||
            request.pluginId !== plugin.manifest.pluginId ||
            (request.method === 'GET' ? 'read' : 'write') !== hostContext.operation))
            throw new FeaturePermissionError('owner HTTP descriptor is inconsistent');
        }
        if (hostContext?.kind === 'owner-operation') {
          if (nativeContext !== undefined || !hostContext.userId || !hostContext.pluginInstanceId || !hostContext.requestId)
            throw new FeaturePermissionError('owner-operation caller is invalid');
          const operation = plugin.manifest.configuration?.find(field => field.kind === 'operation' && field.key === hostContext.operationKey);
          if (!operation || operation.kind !== 'operation' || !operation.actions.some(action =>
            action.id === hostContext.actionId && action.action.method === method))
            throw new FeaturePermissionError('owner-operation tuple does not match its declared method');
        }
        if (hostContext) { hostContext.signal.throwIfAborted(); await hostContext.assertCurrent(); }
        if (disposed) throw new FeatureContextRevokedError();
      };
      await assertCall();
      const result = await handler(input, nativeContext, hostContext);
      await assertCall(); return result;
    },
  ])));
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    actions: guardedActions,
    predicateVerifiers,
    ...(publicInvocationVerifier === undefined ? {} : { publicInvocationVerifier }),
    dispose: () => {
      disposed = true;
      verifierLifetime.abort(new FeatureContextRevokedError());
      disposePromise ??= Promise.resolve().then(() => disposeActivation());
      return disposePromise;
    },
  });
}

/** Validate one manifest truth and bind only activators for declared feature IDs. */
export function definePlugin(input: PluginDefinitionInput): DefinedPlugin {
  const validation = validateManifest(input.manifest);
  if (!validation.valid) {
    throw new TypeError(`plugin manifest is invalid: ${validation.errors[0]?.message ?? 'unknown error'}`);
  }
  const featureIds = new Set(validation.manifest.features.map((feature) => feature.id));
  const activate = input.activate === undefined ? {} : input.activate;
  for (const featureId of Object.keys(activate)) {
    if (!featureIds.has(featureId)) {
      throw new TypeError(`activator ${featureId} is not declared by the plugin manifest`);
    }
  }
  const manifest = deepFreeze(structuredClone(validation.manifest));
  return Object.freeze({ manifest, activate: Object.freeze({ ...activate }) });
}
