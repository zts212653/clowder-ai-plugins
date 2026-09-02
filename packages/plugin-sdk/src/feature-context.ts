import {
  validateManifest,
  type Capability,
  type ConnectorContribution,
  type DirectToolContribution,
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
  readonly connectors: ContributionRegistrar<ConnectorContribution>;
  readonly ui: ContributionRegistrar<UiContribution>;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
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
    const contribution = deepFreeze(structuredClone({ type, ...input })) as unknown as T;
    const key = `${type}:${contribution.id}`;
    const digest = canonicalJson(contribution);
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
    connectors: registrar<ConnectorContribution>('connector'),
    ui: registrar<UiContribution>('ui'),
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

export type FeatureActivator = (context: FeatureContext) => void | Promise<void>;

export interface PluginDefinitionInput {
  readonly manifest: unknown;
  readonly activate?: Readonly<Record<string, FeatureActivator>>;
}

export interface DefinedPlugin {
  readonly manifest: PluginManifest;
  readonly activate: Readonly<Record<string, FeatureActivator>>;
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
