import {
  validateManifest,
  type Capability,
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
    get: (taskId) => runWhileActive(() => adapter.tasks.get(taskId)),
    listByThread: (threadId) => runWhileActive(() => adapter.tasks.listByThread(threadId)),
    listByKind: (kind) => runWhileActive(() => adapter.tasks.listByKind(kind)),
    getBySubject: (subjectKey) => runWhileActive(() => adapter.tasks.getBySubject(subjectKey)),
    create: (input) => runWhileActive(() => adapter.tasks.create(input)),
    upsertBySubject: (input) => runWhileActive(() => adapter.tasks.upsertBySubject(input)),
    update: (taskId, input) => runWhileActive(() => adapter.tasks.update(taskId, input)),
    updateIfThreadId: (taskId, expectedThreadId, input) =>
      runWhileActive(() => adapter.tasks.updateIfThreadId(taskId, expectedThreadId, input)),
  };
  const threads: PluginThreadHost = {
    get: (threadId) => runWhileActive(() => adapter.threads.get(threadId)),
    create: (input) => runWhileActive(() => adapter.threads.create(input)),
    update: (threadId, patch) => runWhileActive(() => adapter.threads.update(threadId, patch)),
    findByKey: (key) => runWhileActive(() => adapter.threads.findByKey(key)),
    ensureByKey: (key, input) => runWhileActive(() => adapter.threads.ensureByKey(key, input)),
    bind: (key, threadId) => runWhileActive(() => adapter.threads.bind(key, threadId)),
    unbind: (key) => runWhileActive(() => adapter.threads.unbind(key)),
    listBindings: () => runWhileActive(() => adapter.threads.listBindings()),
    ensureSystemThread: () => runWhileActive(() => adapter.threads.ensureSystemThread()),
  };
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

  const context: FeatureContext = {
    featureId: binding.featureId,
    config: { get: readConfig },
    secrets: { get: readSecret },
    storage,
    state: storage,
    tasks,
    threads,
    identity: registrar<IdentityContribution>('identity'),
    scheduler: registrar<ScheduleContribution>('schedule'),
    tools: registrar<DirectToolContribution>('tool'),
    mcp: registrar<McpContribution>('mcp'),
    skills: registrar<SkillContribution>('skill'),
    limbs: registrar<LimbContribution>('limb'),
    webhooks: registrar<WebhookContribution>('webhook'),
    messaging: { subscribe: subscribeMessage, unsubscribe: unsubscribeMessage, send: sendMessage },
    media,
    mediaSources: registrar<MediaSourceContribution>('media-source'),
    services: registrar<ServiceContribution>('service'),
    conversationHosts: registrar<CloudConversationHostContribution>('cloud-conversation-host'),
    get dataDirectory(): string {
      assertActive();
      if (binding.dataDirectory === undefined) {
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

export type PluginActionHandler = (input: unknown) => unknown | Promise<unknown>;

export interface FeatureActivation {
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
    case 'schedule':
    case 'tool':
    case 'webhook':
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
  const actions = Object.freeze({ ...(activation.actions ?? {}) });
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
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    actions,
    dispose: () => {
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
