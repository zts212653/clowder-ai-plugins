import type {
  MessageSubscriptionContribution,
  PluginManifest,
  StaticContribution,
} from '@clowder-ai/plugin-contract';

import {
  activateDefinedFeature,
  FeatureContextRevokedError,
  createFeatureContextSession,
  featureActionMethods,
  type ActivePluginFeature,
  type DefinedPlugin,
  type FeatureBinding,
  type FeatureContextSession,
  type FeatureHostAdapter,
  type PluginActionHandler,
} from './feature-context.js';
import type { ModulePluginHostShape, ModulePluginSettingsHost, PluginModuleActivationShape } from './module-host.js';
import { requireDeliveryPresentation } from './p1-runtime.js';

export interface PluginModuleDefinition {
  settings?(host: ModulePluginSettingsHost): {readonly actions: Readonly<Record<string, PluginActionHandler>>; dispose?(): void | Promise<void>} | Promise<{readonly actions: Readonly<Record<string, PluginActionHandler>>; dispose?(): void | Promise<void>}>;
  preStart?(host: ModulePluginHostShape): void | Promise<void>;
  start(host: ModulePluginHostShape): Promise<PluginModuleActivationShape>;
  preUninstall?(host: ModulePluginSettingsHost): void | Promise<void>;
  uninstall?(host: ModulePluginSettingsHost): void | Promise<void>;
}

export interface PluginModuleEntrypoint {
  create(manifest: unknown): PluginModuleDefinition;
}

export class PluginModuleEntrypointError extends TypeError {
  constructor() {
    super('builtin runtime entrypoint default export must satisfy PluginModuleEntrypoint');
    this.name = 'PluginModuleEntrypointError';
  }
}

/** Fail-closed guard for a dynamically imported package module's default export. */
export function requirePluginModuleEntrypoint(candidate: unknown): PluginModuleEntrypoint {
  if (
    candidate === null
    || (typeof candidate !== 'object' && typeof candidate !== 'function')
    || typeof (candidate as { create?: unknown }).create !== 'function'
  ) {
    throw new PluginModuleEntrypointError();
  }
  return candidate as PluginModuleEntrypoint;
}

/** Stable package-module export consumed by a Host-selected runtime carrier. */
export function definePluginModule(
  create: (manifest: unknown) => DefinedPlugin,
): PluginModuleEntrypoint {
  return Object.freeze({
    create: (manifest: unknown): PluginModuleDefinition => {
      const plugin = create(manifest);
      const runtime = plugin.manifest.runtime;
      if (runtime?.transport !== 'builtin' || typeof runtime.entrypoint !== 'string') {
        throw new TypeError('plugin module entrypoint requires a builtin runtime entrypoint');
      }
      return Object.freeze({
        ...(plugin.preStart ? {preStart: plugin.preStart} : {}),
        ...(plugin.preUninstall ? {preUninstall: plugin.preUninstall} : {}),
        ...(plugin.uninstall ? {uninstall: plugin.uninstall} : {}),
        start: (host: ModulePluginHostShape) => startDefinedPluginModule(plugin, host),
      });
    },
  });
}

function featureContributions(
  manifest: PluginManifest,
  featureId: string,
): readonly StaticContribution[] {
  const feature = manifest.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) throw new TypeError(`feature ${featureId} is not declared by the plugin manifest`);
  const keys = new Set((feature.contributions ?? []).map((item) => `${item.type}:${item.id}`));
  return (manifest.contributions ?? []).filter((contribution) => keys.has(`${contribution.type}:${contribution.id}`));
}

function globalActionMethods(manifest: PluginManifest): ReadonlySet<string> {
  const methods = new Set<string>();
  for (const field of manifest.configuration ?? []) {
    if (field.kind !== 'operation') continue;
    for (const action of field.actions) methods.add(action.action.method);
  }
  if (manifest.test !== undefined) methods.add(manifest.test.action.method);
  return methods;
}

function declaredContributionAdapter(
  plugin: DefinedPlugin,
  featureId: string,
  host: ModulePluginHostShape,
): FeatureHostAdapter {
  return {
    members: host.members,
    runtimeInfo: host.runtimeInfo,
    getMessage: messageId => host.messaging.get(messageId),
    readConfig: (_binding, key) => host.config.get(key),
    readSecret: (_binding, key) => host.secrets.get(key),
    storage: host.storage,
    tasks: host.tasks,
    threads: host.threads,
    sendMessage: (_binding, threadId, input) => host.messaging.send({ ...input, threadId }),
    subscribeMessage: (_binding, input) => host.messaging.subscribe(input),
    unsubscribeMessage: (_binding, input) => host.messaging.unsubscribe(input),
    streams: host.streams,
    log: (_binding, level, message, fields) => host.log(level, message, fields),
  };
}

function featureBinding(
  plugin: DefinedPlugin,
  featureId: string,
  host: ModulePluginHostShape,
): FeatureBinding {
  const feature = plugin.manifest.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) throw new TypeError(`feature ${featureId} is not declared by the plugin manifest`);

  return {
    pluginInstanceId: host.pluginInstanceId,
    featureId,
    packageRevision: plugin.manifest.version,
    integrityEpoch: 0,
    activationRevision: 0,
    dataPath: host.dataPath,
    executionLease: 'module-host-bound',
  };
}

async function settleModuleFeatures(
  active: readonly ActivePluginFeature[],
  sessions: readonly FeatureContextSession[],
): Promise<void> {
  const results: PromiseSettledResult<void>[] = [];
  for (const feature of [...active].reverse()) {
    results.push(...await Promise.allSettled([feature.dispose()]));
  }
  for (const session of [...sessions].reverse()) {
    results.push(...await Promise.allSettled([session.revoke()]));
  }
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'plugin module stop failed');
}

async function startDefinedPluginModule(
  plugin: DefinedPlugin,
  host: ModulePluginHostShape,
): Promise<PluginModuleActivationShape> {
  const sessions: FeatureContextSession[] = [];
  const active: ActivePluginFeature[] = [];
  const actions: Record<string, PluginActionHandler> = {};
  const globalMethods = globalActionMethods(plugin.manifest);
  try {
    for (const feature of plugin.manifest.features) {
      if (plugin.activate[feature.id] === undefined) continue;
      const contributions = featureContributions(plugin.manifest, feature.id);
      const session = createFeatureContextSession(
        featureBinding(plugin, feature.id, host),
        declaredContributionAdapter(plugin, feature.id, host),
        {
          messageSubscriptions: contributions.filter(
            (contribution): contribution is MessageSubscriptionContribution =>
              contribution.type === 'message-subscription',
          ),
        },
      );
      sessions.push(session);
      const activated = await activateDefinedFeature(plugin, feature.id, session.context);
      active.push(activated);
      const presentationMethods = new Set(
        contributions
          .filter((contribution): contribution is MessageSubscriptionContribution =>
            contribution.type === 'message-subscription' &&
            (contribution.presentation === 'v1' || contribution.presentation === 'v2'))
          .map(contribution => contribution.action.method),
      );
      for (const [method, handler] of Object.entries(activated.actions)) {
        if (Object.hasOwn(actions, method)) {
          throw new TypeError(`action handler ${method} is exposed by multiple plugin features`);
        }
        actions[method] = presentationMethods.has(method)
          ? (input, context, hostContext) => {
              if (stopPromise) throw new FeatureContextRevokedError();
              if ((input as {kind?:unknown})?.kind !== 'execution_status') requireDeliveryPresentation(input);
              return handler(input, context, hostContext);
            }
          : handler;
      }
    }
    const expected = new Set<string>(globalMethods);
    for (const feature of plugin.manifest.features) {
      for (const method of featureActionMethods(plugin.manifest, feature.id)) expected.add(method);
    }
    const missing = [...expected].find((method) => !Object.hasOwn(actions, method));
    if (missing !== undefined) throw new TypeError(`declared action ${missing} has no plugin handler`);

  } catch (error) {
    await settleModuleFeatures(active, sessions).catch(() => undefined);
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    actions: Object.freeze({ ...actions }),
    ...(active.some(feature => feature.configRefresh) ? {configRefresh: async () => {
      try { for (const feature of active) await feature.configRefresh?.(); }
      catch(error) {stopPromise ??= settleModuleFeatures(active,sessions);await stopPromise.catch(()=>undefined);throw error;}
    }} : {}),
    preStop: async (input) => { for (const feature of [...active].reverse()) await feature.preStop?.(input); },
    ...(active.some(feature => feature.streams) ? {streams: {
      read(reference: string, options?: import('./streams.js').PluginStreamReadOptions) {
        const providers = active.filter(feature => feature.streams);
        if (providers.length !== 1) throw new TypeError('module must expose one stream reader');
        return providers[0]!.streams!.read(reference, options);
      },
    }} : {}),
    stop: () => {
      stopPromise ??= settleModuleFeatures(active, sessions);
      return stopPromise;
    },
  });
}
