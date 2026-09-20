import {
  validateManifest,
  type Capability,
  type ContentEditorProviderContribution,
  type ConnectorContribution,
  type DirectToolContribution,
  type DesktopWindowContribution,
  type IdentityContribution,
  type LimbContribution,
  type McpContribution,
  type MessageSubscriptionContribution,
  type PluginManifest,
  type ScheduleContribution,
  type ServiceContribution,
  type SkillContribution,
  type StaticContribution,
  type UiContribution,
  type WebhookContribution,
} from '@clowder-ai/plugin-contract';

export interface FeatureBinding {
  readonly pluginInstanceId: string;
  readonly featureId: string;
  readonly packageRevision: string;
  readonly integrityEpoch: number;
  readonly activationRevision: number;
  readonly grantRevision: number;
  readonly grantedCapabilities: readonly Capability[];
  /** Opaque Host-issued authority. SDK code transports it but never interprets it. */
  readonly executionLease: string;
}

export interface HostContributionReceipt {
  readonly registrationId: string;
  readonly registryRevision: number;
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConnectorInboundAttachment {
  readonly type: 'image' | 'file' | 'audio' | 'video';
  readonly platformKey: string;
  readonly fileName?: string;
  readonly duration?: number;
}

/** Provider facts only. The Host resolves binding, admission, thread, and wake authority. */
export interface ConnectorInboundMessage {
  readonly externalConversationId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly ConnectorInboundAttachment[];
  readonly sender?: Readonly<{ id: string; name?: string }>;
  readonly conversation?: Readonly<{
    type: 'direct' | 'group';
    providerId?: string;
    title?: string;
  }>;
}

export interface FeatureHostAdapter {
  readConfig(binding: FeatureBinding, key: string): Promise<unknown>;
  readSecret(binding: FeatureBinding, key: string): Promise<string>;
  readState(binding: FeatureBinding, key: string): Promise<unknown>;
  writeState(binding: FeatureBinding, key: string, value: unknown): Promise<void>;
  registerContribution(
    binding: FeatureBinding,
    contribution: StaticContribution,
  ): Promise<HostContributionReceipt>;
  disposeContribution(binding: FeatureBinding, receipt: HostContributionReceipt): Promise<void>;
  deliverConnectorMessage(
    binding: FeatureBinding,
    contributionId: string,
    message: ConnectorInboundMessage,
  ): Promise<void>;
  log(
    binding: FeatureBinding,
    level: PluginLogLevel,
    args: readonly unknown[],
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
  readonly secrets: { get(key: string): Promise<string> };
  readonly state: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  readonly identity: ContributionRegistrar<IdentityContribution>;
  readonly scheduler: ContributionRegistrar<ScheduleContribution>;
  readonly tools: ContributionRegistrar<DirectToolContribution>;
  readonly mcp: ContributionRegistrar<McpContribution>;
  readonly skills: ContributionRegistrar<SkillContribution>;
  readonly limbs: ContributionRegistrar<LimbContribution>;
  readonly webhooks: ContributionRegistrar<WebhookContribution>;
  readonly messaging: {
    readonly subscribe: ContributionRegistrar<MessageSubscriptionContribution>['register'];
  };
  readonly services: ContributionRegistrar<ServiceContribution>;
  readonly connectors: ContributionRegistrar<ConnectorContribution> & {
    deliver(contributionId: string, message: ConnectorInboundMessage): Promise<void>;
  };
  readonly logger: Readonly<Record<PluginLogLevel, (...args: readonly unknown[]) => void>>;
  readonly ui: ContributionRegistrar<UiContribution>;
  readonly contentEditors: ContributionRegistrar<ContentEditorProviderContribution>;
  readonly windows: ContributionRegistrar<DesktopWindowContribution>;
}

export interface FeatureContextSession {
  readonly context: FeatureContext;
  revoke(): Promise<void>;
}

interface ActiveRegistration {
  readonly digest: string;
  readonly promise: Promise<ContributionRegistration>;
  disposePromise?: Promise<void>;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
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
  const readSecret = async (key: string): Promise<string> => {
    return runWhileActive(() => adapter.readSecret(binding, key));
  };
  const readState = async (key: string): Promise<unknown> => {
    return runWhileActive(() => adapter.readState(binding, key));
  };
  const writeState = async (key: string, value: unknown): Promise<void> => {
    return runWhileActive(() => adapter.writeState(binding, key, value));
  };

  const connectorRegistrar = registrar<ConnectorContribution>('connector');
  const deliverConnectorMessage = async (
    contributionId: string,
    message: ConnectorInboundMessage,
  ): Promise<void> => {
    return runWhileActive(() => adapter.deliverConnectorMessage(binding, contributionId, message));
  };

  const log = (
    level: PluginLogLevel,
    args: readonly unknown[],
  ): void => {
    assertActive();
    adapter.log(binding, level, args);
  };

  const subscriptions = registrar<MessageSubscriptionContribution>('message-subscription');
  const context: FeatureContext = {
    featureId: binding.featureId,
    config: { get: readConfig },
    secrets: { get: readSecret },
    state: { get: readState, set: writeState },
    identity: registrar<IdentityContribution>('identity'),
    scheduler: registrar<ScheduleContribution>('schedule'),
    tools: registrar<DirectToolContribution>('tool'),
    mcp: registrar<McpContribution>('mcp'),
    skills: registrar<SkillContribution>('skill'),
    limbs: registrar<LimbContribution>('limb'),
    webhooks: registrar<WebhookContribution>('webhook'),
    messaging: { subscribe: subscriptions.register },
    services: registrar<ServiceContribution>('service'),
    connectors: { ...connectorRegistrar, deliver: deliverConnectorMessage },
    logger: {
      debug: (...args) => log('debug', args),
      info: (...args) => log('info', args),
      warn: (...args) => log('warn', args),
      error: (...args) => log('error', args),
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
  dispose(): void | Promise<void>;
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

export interface PluginModuleEntrypoint {
  create(manifest: unknown): DefinedPlugin;
}

/** Stable package-module export consumed by a Host-selected runtime carrier. */
export function definePluginModule(
  create: (manifest: unknown) => DefinedPlugin,
): PluginModuleEntrypoint {
  return Object.freeze({ create });
}

function actionMethods(contribution: StaticContribution): readonly string[] {
  switch (contribution.type) {
    case 'connector':
      return [contribution.outboundMethod];
    case 'schedule':
    case 'tool':
    case 'webhook':
    case 'message-subscription':
      return [contribution.action.method];
    case 'service':
      return [contribution.healthMethod];
    case 'ui':
      return contribution.kind === 'command' ? [contribution.action.method] : [];
    default:
      return [];
  }
}

function featureActionMethods(manifest: PluginManifest, featureId: string): ReadonlySet<string> {
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
): Promise<ActivePluginFeature> {
  if (context.featureId !== featureId) {
    throw new TypeError(`feature context ${context.featureId} cannot activate ${featureId}`);
  }
  const activate = plugin.activate[featureId];
  if (activate === undefined) {
    throw new TypeError(`feature ${featureId} has no package activator`);
  }
  const result = await activate(context);
  const activation = result ?? { dispose: () => undefined };
  const actions = Object.freeze({ ...(activation.actions ?? {}) });
  const allowedMethods = featureActionMethods(plugin.manifest, featureId);
  const undeclared = Object.keys(actions).find((method) => !allowedMethods.has(method));
  if (undeclared !== undefined) {
    await Promise.resolve(activation.dispose()).catch(() => undefined);
    throw new TypeError(`action handler ${undeclared} is not declared by feature ${featureId}`);
  }
  const missing = [...allowedMethods].find((method) => actions[method] === undefined);
  if (missing !== undefined) {
    await Promise.resolve(activation.dispose()).catch(() => undefined);
    throw new TypeError(`declared action ${missing} has no handler for feature ${featureId}`);
  }
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    actions,
    dispose: () => {
      disposePromise ??= Promise.resolve().then(() => activation.dispose());
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
