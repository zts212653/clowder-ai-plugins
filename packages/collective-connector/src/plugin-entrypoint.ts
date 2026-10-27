import type { CollectiveMaterialSourcePort } from './business/contracts/types/collective-material.js';
import { activateCollectiveWork } from './work-native-activation.js';
import { createCollectiveAgentVerification } from './native-agent-verification.js';
import { createCollectiveOwnerSendAction } from './collective-owner-native-send.js';
import { createCollectiveOwnerView } from './owner-participation-caller.js';
import { createCollectiveOwnerRouteChange } from './owner-route-caller.js';
import { createCollectiveOwnerParticipationChange } from './owner-participation-change.js';
import { activateCollectivePublicNative } from './public-native-activation.js';
import { join } from 'node:path';
import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type FeatureActivation,
  type PluginActionContext,
  type PluginActionHandler,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';
import { createCollectiveEntryCaller } from './entry-control.js';
import { createCollectiveParticipationCaller } from './participation-reconciler.js';
import { createRecoveryActions } from './recovery-actions.js';
import { createCollectiveMediaHttp } from './collective-media-http.js';
import { createOwnerControlHttp } from './owner-control-http.js';
import { createPluginService } from './plugin-service.js';
import { CollectiveConnector } from './business/connector/connector.js';
import { startCollectiveBackgroundSync } from './collective-background-sync.js';

export type CollectivePluginModuleOptions = Readonly<Record<string, never>>;

interface WorkBackend {
  readonly connector: CollectiveConnector;
  isAllowedOrigin(origin: string): boolean;
  withAction<T>(action: PluginActionContext, run: () => Promise<T>): Promise<T>;
  assertActive(): void;
  startBackground(workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>): void;
}
async function activateService(
  context: FeatureContext,
  ready: (backend: WorkBackend) => void,
  expectsWork: boolean,
  artifactOwner?: import('@clowder-ai/plugin-sdk').CollectiveArtifactOwnerPort & {
    readonly attachments?: import('./business/contracts/message-attachment-owner.js').CollectiveMessageAttachmentOwnerPort;
  },
  materialSource?: CollectiveMaterialSourcePort,
): Promise<FeatureActivation> {
  let stopped = false;
  const assertActive = () => {
    if (stopped) throw new Error('Collective module is stopped');
    void context.dataPath;
  };
  const allowedHostOrigins = new Set<string>();
  const originsKey = 'collective.allowed-host-origins.v1';
  const storedOrigins = (await context.storage.get(originsKey))?.value;
  if (storedOrigins !== undefined) {
    if (
      !Array.isArray(storedOrigins) ||
      storedOrigins.some((value) => typeof value !== 'string' || !validOrigin(value))
    )
      throw new Error('Invalid saved Collective allowed origins');
    for (const value of storedOrigins) allowedHostOrigins.add(value as string);
  }
  const admitOwnerOrigin = async (value: string) => {
    if (!validOrigin(value)) throw new Error('Invalid owner origin');
    assertActive();
    for (;;) {
      const entry = await context.storage.get(originsKey);
      const values = entry?.value ?? [];
      if (!Array.isArray(values) || values.some((item) => typeof item !== 'string' || !validOrigin(item)))
        throw new Error('Invalid saved Collective allowed origins');
      const next = [...new Set([...values, value])];
      if ((await context.storage.compareAndSet(originsKey, entry?.revision ?? null, next)).applied) {
        assertActive();
        for (const item of next) allowedHostOrigins.add(item);
        return;
      }
    }
  };
  const service = await createPluginService(context, allowedHostOrigins, assertActive, artifactOwner?.attachments);
  const verification = createCollectiveAgentVerification(assertActive);
  const connector = await CollectiveConnector.open({
    dataDirectory: join(context.dataPath, 'connector'),
    verifyAgent: verification.verifyAgent,
    localTransport: service.localTransport,
  });
  connector.setArtifactOwner(artifactOwner);
  connector.setMaterialSource(materialSource);
  const background = new AbortController();
  let stopBackground: (() => Promise<void>) | undefined;
  try {
    await service.start();
    const native = await activateCollectivePublicNative(context, connector, assertActive);
    const startBackground = (workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>) => {
      if (stopBackground) throw new Error('Collective background sync is already active');
      const current = async () => {
        assertActive();
        background.signal.throwIfAborted();
      };
      stopBackground = startCollectiveBackgroundSync(async () => {
        await current();
        for (const connection of await connector.listConnections()) {
          if (connection.authorityStatus === 'revoked') continue;
          try {
            await current();
            await connector.sync(connection.connectionId);
            await current();
            await native.syncModule(connection.connectionId, current, background.signal);
            await current();
            await workSync(connection.connectionId, current);
            await current();
          } catch {
            assertActive();
          }
        }
      });
    };
    ready({
      connector,
      isAllowedOrigin: (value) => allowedHostOrigins.has(value),
      assertActive,
      startBackground,
      withAction: verification.withAction,
    });
    if (!expectsWork) startBackground(async () => {});
    if (!context.members || !context.threads) throw new Error('Collective owner roster/thread ports are required');
    const roster = context.members,
      threads = context.threads;
    const entry = createCollectiveEntryCaller({
      connector,
      members: roster,
      async assertCurrent() {
        assertActive();
      },
    });
    const ownerControl = createOwnerControlHttp({
      connector,
      admitOwnerOrigin,
      entry,
      routeChange: createCollectiveOwnerRouteChange(context, connector, async () => {
        assertActive();
      }),
      participation: createCollectiveOwnerParticipationChange(context, connector, async () => {
        assertActive();
      }),
      view: createCollectiveOwnerView(context, connector, async () => {
        assertActive();
      }),
      async reconcile(ownerUserId, connectionId, input) {
        const current = async () => {
          assertActive();
        };
        const connection = await connector.getProjection(connectionId);
        const route = await connector.getHostRoute(connectionId);
        await current();
        if (route && route.localOwnerUserId !== ownerUserId)
          throw Object.assign(new Error('Connection belongs to another owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
        if (connection.authorityStatus !== 'connected' || !connection.authorizedHumanId)
          throw Object.assign(new Error('Collective participation authority is revoked'), {
            code: 'PARTICIPATION_REVOKED',
          });
        return createCollectiveParticipationCaller({
          ownerUserId,
          members: roster,
          threads,
          connector,
          assertCurrent: current,
        }).reconcile({ ...input, connectionId, route, initialExcludedCatIds: connection.initialExcludedCatIds });
      },
      assertActive() {
        if (stopped) throw new Error('Collective module is stopped');
        void context.dataPath;
      },
      status: service.localStatus,
      ...(service.remoteStatus ? { remoteStatus: async () => service.remoteStatus!(await connector.listConnections()) } : {}),
      launch: service.launch,
    });
    return {
      actions: {
        ...Object.fromEntries(
          Object.entries(native.actions).map(([method, handler]) => [
            method,
            ((input, action, caller) =>
              action
                ? verification.withAction(action, async () => handler(input, action, caller))
                : handler(input, action, caller)) as PluginActionHandler,
          ]),
        ),
        'collective.connector.send': createCollectiveOwnerSendAction({ connector, roster, verification, assertActive }),
        ...createRecoveryActions(connector, async () => assertActive()),
        'collective.control.http': ownerControl,
        'collective.media.http': createCollectiveMediaHttp({
          connector,
          owner: artifactOwner,
          assertActive,
        }) as PluginActionHandler,
        'collective.service.status': async () => {
          assertActive();
          return service.statusAction(await connector.listConnections());
        },
      },
      async dispose() {
        stopped = true;
        background.abort();
        try {
          await stopBackground?.();
        } finally {
          try {
            await connector.stopMediaReads();
          } finally {
            await service.close();
          }
        }

      },
    };
  } catch (error) {
    stopped = true;
    background.abort();
    await Promise.allSettled([stopBackground?.(), connector.stopMediaReads(), service.close()]);
    throw error;
  }
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function createCollectivePluginModule(_options: CollectivePluginModuleOptions = {}): PluginModuleEntrypoint {
  return {
    create(manifest) {
      let artifactOwner: import('@clowder-ai/plugin-sdk').CollectiveArtifactOwnerPort | undefined;
      let materialSource: CollectiveMaterialSourcePort | undefined;
      const entrypoint = definePluginModule((manifest) => {
        const plugin = definePlugin({ manifest });
        let backend: WorkBackend | undefined;
        return definePlugin({
          manifest,
          activate: {
            'collective-backend': (context) =>
              activateService(
                context,
                (current) => {
                  backend = current;
                },
                plugin.manifest.features.some((feature) => feature.id === 'collective-work'),
                artifactOwner,
                materialSource,
              ),
            ...(plugin.manifest.features.some((feature) => feature.id === 'collective-work')
              ? {
                  'collective-work': async (context: FeatureContext) => {
                    if (!backend) throw new Error('Collective backend must be active before Work');
                    const activation = await activateCollectiveWork(context, backend);
                    return activation;
                  },
                }
              : {}),
          },
        });
      });
      const definition = entrypoint.create(manifest);
      return {
        ...definition,
        start(host) {
          artifactOwner = host.collectiveArtifactOwner;
          materialSource = (host as typeof host & { collectiveMaterialSource?: CollectiveMaterialSourcePort })
            .collectiveMaterialSource;
          return definition.start(host);
        },
      };
    },
  };
}

export default createCollectivePluginModule();
