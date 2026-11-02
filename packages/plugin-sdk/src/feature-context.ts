import { createStreamsClient, type PluginStreams } from './streams.js';
import {
  projectTaskDataControllerMutationResult,
  projectTaskRead,
  projectTaskReadList,
} from './task-read.js';
import { createMessageReader, type PluginMessage } from './message-read.js';
import { createMemberClient, type PluginMemberHost } from './members.js';
import type { PluginHostActionContext } from './host-action-context.js';
import {
  validateManifest,
  type CloudConversationHostContribution,
  type ContentEditorProviderContribution,
  type DirectToolContribution,
  type DesktopWindowContribution,
  type IdentityContribution,
  type LimbContribution,
  type McpContribution,
  type MessageSubscriptionContribution,
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
  PluginTaskHostAdapter,
  PluginTaskHost,
  PluginThreadHost,
} from './module-host.js';


export interface FeatureBinding {
  readonly pluginInstanceId: string;
  readonly featureId: string;
  readonly packageRevision: string;
  readonly integrityEpoch: number;
  readonly activationRevision: number;
  /**
   * Absolute path of the Host-provisioned data directory. Present only when the
   * owning instance starts and the manifest
   * declares runtime.dataDirectory.
   */
  readonly dataPath?: string;
  /** Opaque Host-issued authority. SDK code transports it but never interprets it. */
  readonly executionLease: string;
}

export type PluginLogLevel = ModulePluginLogLevel;

export interface FeatureHostAdapter {
  readonly runtimeInfo?: import('./runtime-info.js').PluginRuntimeInfoHost;
  getMessage(messageId: string): Promise<PluginMessage | null>;
  readonly members?: PluginMemberHost;
  readConfig(binding: FeatureBinding, key: string): Promise<unknown>;
  readSecret(binding: FeatureBinding, key: string): Promise<string | undefined>;
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHostAdapter;
  readonly threads: PluginThreadHost;
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
  readonly streams: PluginStreams;
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

export class FeaturePermissionError extends Error {
  readonly code = 'PERMISSION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FeaturePermissionError';
  }
}

export interface FeatureContext {
  readonly runtimeInfo?: import('./runtime-info.js').PluginRuntimeInfoHost;
  /** Host installation attribution. This id grants no operation or business authority. */
  readonly pluginInstanceId: string;
  /** One ordinary Host member directory. */
  readonly members?: PluginMemberHost;
  readonly featureId: string;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  readonly messaging: {
    readonly get: (messageId: string) => Promise<PluginMessage | null>;
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
  readonly streams: PluginStreams;
  /**
   * Stable Host-provisioned instance data path. Access checks instance lifetime.
   */
  readonly dataPath: string;
  readonly log: (
    level: PluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface FeatureContextSession {
  readonly context: FeatureContext;
  revoke(): Promise<void>;
}

export interface FeatureContextSessionOptions {
  readonly messageSubscriptions?: readonly MessageSubscriptionContribution[];
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
 * remains responsible for verifying its signature, revisions, ownership, integrity epoch, and liveness.
 */
export function createFeatureContextSession(
  binding: FeatureBinding,
  adapter: FeatureHostAdapter,
  options: FeatureContextSessionOptions = {},
): FeatureContextSession {
  let revoked = false;
  let revokePromise: Promise<void> | undefined;
  const lifetime = new AbortController();

  const assertActive = (): void => {
    if (revoked) throw new FeatureContextRevokedError();
  };

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
    get: selector => runWhileActive(async () => projectTaskRead(await adapter.tasks.get(selector))),
    list: filter => runWhileActive(async () => projectTaskReadList(await adapter.tasks.list(filter))),
    create: (input, options) => runWhileActive(() => adapter.tasks.create(input, options)),
    update: (taskId, patch, conditions) => runWhileActive(() => {
      if (Object.hasOwn(patch, 'wait') && Object.keys(patch).some(key => key !== 'wait'))
        throw new TypeError('Task wait patch cannot mix other fields');
      return adapter.tasks.update(taskId, patch, conditions);
    }),
    bindDataController: (input) => runWhileActive(async () => {
      if (typeof adapter.tasks.bindDataController !== 'function') {
        throw new FeaturePermissionError('Host Task data-controller binding is unavailable');
      }
      const result = projectTaskDataControllerMutationResult(await adapter.tasks.bindDataController(input));
      if (result.task.id !== input.taskId) {
        throw new TypeError('Task data-controller result identifies another Task');
      }
      return result;
    }),
    revokeDataController: (input) => runWhileActive(async () => {
      if (typeof adapter.tasks.revokeDataController !== 'function') {
        throw new FeaturePermissionError('Host Task data-controller revocation is unavailable');
      }
      const result = projectTaskDataControllerMutationResult(await adapter.tasks.revokeDataController(input));
      if (result.task.id !== input.taskId) {
        throw new TypeError('Task data-controller result identifies another Task');
      }
      return result;
    }),
  };
  const threads: PluginThreadHost = {
    get: (threadId) => runWhileActive(() => adapter.threads.get(threadId)),
    list: (options) => runWhileActive(() => adapter.threads.list(options)),
    readMessages: (threadId, options) => runWhileActive(() => adapter.threads.readMessages(threadId, options)),
    getCats: (threadId) => runWhileActive(() => adapter.threads.getCats(threadId)),
    addParticipants: (input) => runWhileActive(() => adapter.threads.addParticipants(input)),
    create: (input) => runWhileActive(() => adapter.threads.create(input)),
    update: (threadId, patch) => runWhileActive(() => adapter.threads.update(threadId, patch)),
  };
  const getMessage = createMessageReader(messageId => adapter.getMessage(messageId), assertActive);
  const members = adapter.members === undefined ? undefined : createMemberClient(adapter.members, assertActive);
  const runtimeInfo = adapter.runtimeInfo === undefined ? undefined : { async get() {
    assertActive(); const result = await adapter.runtimeInfo!.get(); assertActive(); return structuredClone(result);
  } };
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
  const streams = createStreamsClient({read: (reference, options) => adapter.streams.read(reference, options)}, assertActive, lifetime.signal);

  const log = (
    level: PluginLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    assertActive();
    adapter.log(binding, level, message, fields);
  };

  const context: FeatureContext = {
    get pluginInstanceId() {
      assertActive();
      if (typeof binding.pluginInstanceId !== 'string' || !binding.pluginInstanceId.trim())
        throw new TypeError('Host installed plugin instance id is unavailable');
      return binding.pluginInstanceId;
    },
    ...(members ? { members } : {}),
    ...(runtimeInfo ? { runtimeInfo } : {}),
    featureId: binding.featureId,
    config: { get: readConfig },
    secrets: { get: readSecret },
    storage,
    tasks,
    threads,
    messaging: { get: getMessage, subscribe: subscribeMessage, unsubscribe: unsubscribeMessage, send: sendMessage },
    streams,
    get dataPath(): string {
      assertActive();
      if (!binding.dataPath) throw new TypeError('Host dataPath is unavailable');
      return binding.dataPath;
    },
    log,
  };

  return {
    context,
    revoke: () => {
      revoked = true;
      if (revokePromise !== undefined) return revokePromise;
      lifetime.abort(new FeatureContextRevokedError());
      revokePromise = Promise.resolve();
      return revokePromise;
    },
  };
}

export type PluginActionHandler = (input: unknown, context?: import('./module-action-client.js').PluginActionContext, hostContext?: PluginHostActionContext) => unknown | Promise<unknown>;

export interface FeatureActivation {
  readonly streams?: PluginStreams;
  configRefresh?(): void | Promise<void>;
  preStop?(context: import('./module-host.js').PluginPreStopContext): void | Promise<void>;
  readonly actions?: Readonly<Record<string, PluginActionHandler>>;
  dispose?(): void | Promise<void>;
}

export type FeatureActivator = (
  context: FeatureContext,
) => void | FeatureActivation | Promise<void | FeatureActivation>;

interface PluginDefinitionHooks {
  preStart?(host: import('./module-host.js').ModulePluginHostShape): void | Promise<void>;
  preUninstall?(host: import('./module-host.js').ModulePluginSettingsHost): void | Promise<void>;
  uninstall?(host: import('./module-host.js').ModulePluginSettingsHost): void | Promise<void>;
}
export interface PluginDefinitionInput extends PluginDefinitionHooks {
  readonly manifest: unknown;
  readonly activate?: Readonly<Record<string, FeatureActivator>>;
}

export interface DefinedPlugin extends PluginDefinitionHooks {
  readonly manifest: PluginManifest;
  readonly activate: Readonly<Record<string, FeatureActivator>>;
}

export interface ActivePluginFeature {
  readonly streams?: PluginStreams;
  configRefresh?(): void | Promise<void>;
  preStop?(context: import('./module-host.js').PluginPreStopContext): void | Promise<void>;
  readonly actions: Readonly<Record<string, PluginActionHandler>>;
  dispose(): Promise<void>;
}

function actionMethods(contribution: StaticContribution): readonly string[] {
  switch (contribution.type) {
    case 'schedule':
    case 'tool':
    case 'webhook':
      return [contribution.action.method];
    case 'message-subscription':
      return [contribution.action.method];
    case 'media-source':
      return [];
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

/** Activate one feature and bind exported handlers to its lifecycle. */
export async function activateDefinedFeature(
  plugin: DefinedPlugin,
  featureId: string,
  context: FeatureContext,
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
  const requiredMethods = featureActionMethods(plugin.manifest, featureId);
  const missing = [...requiredMethods].find((method) => actions[method] === undefined);
  if (missing !== undefined) {
    await Promise.resolve(disposeActivation()).catch(() => undefined);
    throw new TypeError(`declared action ${missing} has no handler for feature ${featureId}`);
  }
  let disposed = false;
  const ownerWebhooks = (plugin.manifest.contributions ?? []).filter(
    (contribution): contribution is WebhookContribution => contribution.type === 'webhook',
  );
  const guardedActions = Object.freeze(Object.fromEntries(Object.entries(actions).map(([method, handler]) => [method,
    async (input: unknown, nativeContext?: import('./module-action-client.js').PluginActionContext, hostContext?: PluginHostActionContext) => {
      const assertCall = async () => {
        if (disposed) throw new FeatureContextRevokedError();
        if (hostContext && (hostContext.kind !== 'owner-operation' && hostContext.kind !== 'owner-http-request'))
          throw new FeaturePermissionError('unknown Host action context');
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
    ...(activation.streams ? {streams: createStreamsClient(activation.streams, () => { if (disposed) throw new FeatureContextRevokedError(); })} : {}),
    ...(activation.configRefresh ? {configRefresh: () => activation.configRefresh!()} : {}),
    ...(activation.preStop ? {preStop: (input: import('./module-host.js').PluginPreStopContext) => activation.preStop!(input)} : {}),
    dispose: () => {
      disposed = true;
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
  return Object.freeze({ manifest, activate: Object.freeze({ ...activate }),
    ...(input.preStart ? {preStart: input.preStart} : {}),
    ...(input.preUninstall ? {preUninstall: input.preUninstall} : {}),
    ...(input.uninstall ? {uninstall: input.uninstall} : {}),
  });
}
