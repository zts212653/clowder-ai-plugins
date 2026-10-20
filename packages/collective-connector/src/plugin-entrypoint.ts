import { activateCollectiveWork } from './work-native-activation.js';
import { createCollectiveAgentVerification } from './native-agent-verification.js';
import { createCollectiveOwnerSendAction } from './collective-owner-native-send.js';
import { createCollectiveOwnerView } from './owner-participation-caller.js';
import { createCollectiveOwnerRouteChange } from './owner-route-caller.js';
import { createCollectiveOwnerParticipationChange } from './owner-participation-change.js';
import { activateCollectivePublicNative } from './public-native-activation.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { definePlugin, definePluginModule, type FeatureContext, type FeatureActivation, type PluginActionContext, type PluginActionHandler, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { startCollectiveServer } from './business/service/http-server.js';
import { loadCollectiveClient } from './client-assets.js';
import { createCollectiveEntryCaller } from './entry-control.js';
import { createCollectiveParticipationCaller } from './participation-reconciler.js';
import { COLLECTIVE_NATIVE_ID } from './public-native-methods.js';
import { createLocalServiceTransport } from './local-service-transport.js';
import { createRecoveryActions } from './recovery-actions.js';
import { createCollectiveMediaHttp } from './collective-media-http.js';
import { createOwnerControlHttp, type CollectiveLocalServiceStatus } from './owner-control-http.js';
import { CollectiveConnector } from './business/connector/connector.js';
import { GitHubAppManifestSetup } from './business/service/github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './business/service/github-human-auth-provider.js';
import { CollectiveServiceStore } from './business/service/store.js';
import { createSecret } from './business/service/persistence.js';
import {startCollectiveBackgroundSync} from './collective-background-sync.js';

export type CollectivePluginModuleOptions = Readonly<Record<string, never>>;

async function readBootstrapSecret(path: string): Promise<string> {
  const secret = (await readFile(path, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Private owner bootstrap credential is invalid');
  return secret;
}

async function escrowBootstrapSecret(path: string): Promise<string> {
  try { return await readBootstrapSecret(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const secret = createSecret();
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(secret + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
  return secret;
}

async function writeBootstrapLink(path: string, link: string): Promise<void> {
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, link + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally { await rm(temporaryPath, { force: true }); }
}

interface WorkBackend {
  readonly connector: CollectiveConnector;
  isAllowedOrigin(origin: string): boolean;
  withAction<T>(action: PluginActionContext, run: () => Promise<T>): Promise<T>;
  assertActive(): void;
  startBackground(workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>): void;
}
async function activateService(context: FeatureContext,
  ready: (backend: WorkBackend) => void, expectsWork: boolean,
  artifactOwner?: import('@clowder-ai/plugin-sdk').CollectiveArtifactOwnerPort): Promise<FeatureActivation> {
  let stopped = false;
  const assertActive = () => { if (stopped) throw new Error('Collective module is stopped'); void context.dataPath; };
  const portValue = await context.config.get('servicePort');
  const port = portValue === undefined || portValue === '' ? 5201 : Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 3001 || port === 3002)
    throw new Error('Collective servicePort must be a non-reserved local port (1024–65535)');
  const origin = `http://127.0.0.1:${port}`;
  const client = await loadCollectiveClient(new URL('../assets/client/', import.meta.url));
  const allowedHostOrigins = new Set<string>([origin]);
  const originsKey = 'collective.allowed-host-origins.v1';
  const storedOrigins = (await context.storage.get(originsKey))?.value;
  if (storedOrigins !== undefined) {
    if (!Array.isArray(storedOrigins) || storedOrigins.some(value => typeof value !== 'string' || !validOrigin(value)))
      throw new Error('Invalid saved Collective allowed origins');
    for (const value of storedOrigins) allowedHostOrigins.add(value as string);
  }
  const admitOwnerOrigin = async (value: string) => {
    if (!validOrigin(value)) throw new Error('Invalid owner origin');
    assertActive();
    for (;;) {
      const entry = await context.storage.get(originsKey);
      const values = entry?.value ?? [];
      if (!Array.isArray(values) || values.some(item => typeof item !== 'string' || !validOrigin(item)))
        throw new Error('Invalid saved Collective allowed origins');
      const next = [...new Set([...values, value])];
      if ((await context.storage.compareAndSet(originsKey, entry?.revision ?? null, next)).applied) {
        assertActive(); for (const item of next) allowedHostOrigins.add(item); return;
      }
    }
  };
  const dataDirectory = join(context.dataPath, 'service');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider });
  const bootstrapSecretPath = join(dataDirectory, 'owner-bootstrap.secret');
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: provider,
    clientBuildId: client.clientBuildId, humanAuthRedirectUri: origin + '/api/auth/github/callback',
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapSecret = opened.store.getMetadata().bootstrapNeeded ? await readBootstrapSecret(bootstrapSecretPath) : undefined;
  if (!bootstrapSecret) await rm(bootstrapSecretPath, { force: true });
  const bootstrapLinkPath = join(dataDirectory, 'owner-bootstrap.url');
  if (bootstrapSecret) await writeBootstrapLink(bootstrapLinkPath, origin + '#bootstrap=' + encodeURIComponent(bootstrapSecret));
  const verification = createCollectiveAgentVerification(assertActive);
  const connector = await CollectiveConnector.open({ dataDirectory: join(context.dataPath, 'connector'),
    verifyAgent: verification.verifyAgent, localTransport: createLocalServiceTransport(origin, assertActive, opened.store) });
  connector.setArtifactOwner(artifactOwner);
  const server = await startCollectiveServer({store: opened.store, port, allowedHostOrigins, bootstrapLinkPath, githubAppSetup, clientAssets: client.files});
  const background = new AbortController();
  let stopBackground: (() => Promise<void>) | undefined;
  try {
  const native = await activateCollectivePublicNative(context, connector, assertActive);
  const startBackground = (workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>) => {
    if (stopBackground) throw new Error('Collective background sync is already active');
    const current = async () => {assertActive();background.signal.throwIfAborted();};
    stopBackground = startCollectiveBackgroundSync(async () => {
      await current();
      for (const connection of await connector.listConnections()) {
        if (connection.authorityStatus === 'revoked') continue;
        try {
          await current();await connector.sync(connection.connectionId);await current();
          await native.syncModule(connection.connectionId, current, background.signal);await current();
          await workSync(connection.connectionId, current);await current();
        } catch {assertActive();}
      }
    });
  };
  ready({connector, isAllowedOrigin: value => allowedHostOrigins.has(value), assertActive, startBackground, withAction: verification.withAction});
  if (!expectsWork) startBackground(async () => {});
  const localServiceStatus = (): CollectiveLocalServiceStatus => {
    const metadata = opened.store.getMetadata();
    return { state: metadata.onboardingComplete ? 'ready' : 'setup_required', serviceUrl: origin, dataDirectory,
      serviceInstanceId: metadata.serviceInstanceId, bootstrapNeeded: metadata.bootstrapNeeded,
      ...(!metadata.onboardingComplete ? { setupStep: provider.readiness.ready ? 'owner_setup' as const : 'github_app' as const } : {}) };
  };
  if (!context.members || !context.threads) throw new Error('Collective owner roster/thread ports are required');
  const roster = context.members, threads = context.threads;
  const entry = createCollectiveEntryCaller({ connector, members: roster,
    async assertCurrent() { assertActive(); } });
  const ownerControl = createOwnerControlHttp({ connector, admitOwnerOrigin, entry,
    routeChange: createCollectiveOwnerRouteChange(context, connector, async () => { assertActive(); }),
    participation: createCollectiveOwnerParticipationChange(context, connector, async () => { assertActive(); }),
    view: createCollectiveOwnerView(context, connector, async () => { assertActive(); }),
    async reconcile(ownerUserId, connectionId, input) {
      const current = async () => { assertActive(); };
      const connection = await connector.getProjection(connectionId);
      const route = await connector.getHostRoute(connectionId); await current();
      if (route && route.localOwnerUserId !== ownerUserId) throw Object.assign(new Error('Connection belongs to another owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
      if (connection.authorityStatus !== 'connected' || !connection.authorizedHumanId) throw Object.assign(new Error('Collective participation authority is revoked'), { code: 'PARTICIPATION_REVOKED' });
      return createCollectiveParticipationCaller({ ownerUserId, members: roster,
        threads, connector, assertCurrent: current }).reconcile({ ...input, connectionId, route,
          initialExcludedCatIds: connection.initialExcludedCatIds });
    },
    assertActive() { if (stopped) throw new Error('Collective module is stopped'); void context.dataPath; },
    status: localServiceStatus,
    async launch() {
      const service = localServiceStatus();
      // Bootstrap is delivered only through the Host-authenticated control lane, never public status.
      const launchUrl = service.bootstrapNeeded
        ? origin + '#bootstrap=' + encodeURIComponent(await readBootstrapSecret(bootstrapSecretPath)) : origin;
      return { service, launchUrl };
    },
  });
  return {
    actions: {
      ...Object.fromEntries(Object.entries(native.actions).map(([method, handler]) => [method,
        ((input, action, caller) => action ? verification.withAction(action, async () => handler(input, action, caller))
          : handler(input, action, caller)) as PluginActionHandler])),
      'collective.connector.send': createCollectiveOwnerSendAction({ connector, roster, verification, assertActive }),
      ...createRecoveryActions(connector, async () => assertActive()),
      'collective.control.http': ownerControl,
      'collective.media.http': createCollectiveMediaHttp({connector, owner:artifactOwner, assertActive}) as PluginActionHandler,
      'collective.service.status': async () => {
        if (stopped) throw new Error('Collective module is stopped');
        // Access is revoked by the same SDK session on disable.
        void context.dataPath;
        const metadata = opened.store.getMetadata();
        const setupState = metadata.bootstrapNeeded ? 'owner bootstrap required'
          : metadata.onboardingComplete ? 'onboarding complete' : 'onboarding pending';
        return { render: 'status', label: `Collective service running · ${setupState} · ${origin}${!metadata.onboardingComplete
          ? ' · Open Collective to finish account setup and pair a connection.' : ''}`,
          data: { state: 'running', url: origin, ...metadata, connections: await connector.listConnections() } };
      },
    },
    async dispose() {
      stopped = true;
      background.abort();
      try { await stopBackground?.(); } finally {
        try { await connector.stopMediaReads(); } finally { await server.close(); }
      }

      if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    },
  };
  } catch (error) {
    stopped = true; background.abort();
    await Promise.allSettled([stopBackground?.(), connector.stopMediaReads(), server.close()]);
    throw error;
  }
}

function validOrigin(value: string): boolean {
  try { const url = new URL(value); return url.origin === value && ['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

export function createCollectivePluginModule(_options: CollectivePluginModuleOptions = {}): PluginModuleEntrypoint {
  return {create(manifest) {
    let artifactOwner: import('@clowder-ai/plugin-sdk').CollectiveArtifactOwnerPort | undefined;
    const entrypoint = definePluginModule(manifest => {
    const plugin = definePlugin({ manifest });
    let backend: WorkBackend | undefined;
    return definePlugin({ manifest, activate: {
      'collective-backend': context => activateService(context, current => {backend = current;},
        plugin.manifest.features.some(feature => feature.id === 'collective-work'), artifactOwner),
      ...(plugin.manifest.features.some(feature => feature.id === 'collective-work') ? {
        'collective-work': async (context: FeatureContext) => {
          if (!backend) throw new Error('Collective backend must be active before Work');
          const activation = await activateCollectiveWork(context, backend);
          return activation;
        },
      } : {}),
    } });
    });
    const definition = entrypoint.create(manifest);
    return {...definition, start(host) {
      artifactOwner = host.collectiveArtifactOwner;
      return definition.start(host);
    }};
  }};
}

export default createCollectivePluginModule();
