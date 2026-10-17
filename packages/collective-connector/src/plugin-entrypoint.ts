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
import { definePlugin, definePluginModule, type FeatureContext, type FeatureActivation, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { BROWSER_SERVICE_LIMITS, type BrowserServiceContribution } from '@clowder-ai/plugin-sdk';
import { createCollectiveEntryCaller } from './entry-control.js';
import { createCollectiveParticipationCaller } from './participation-reconciler.js';
import { COLLECTIVE_NATIVE_ID } from './public-native-methods.js';
import { createNodeHttpAdapter } from './node-http-adapter.js';
import { createLocalServiceTransport } from './local-service-transport.js';
import { createRecoveryActions } from './recovery-actions.js';
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
  readonly parentOrigin: string;
  assertActive(): void;
  startBackground(workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>): void;
}
async function activateService(context: FeatureContext, declaration: BrowserServiceContribution,
  ready: (backend: WorkBackend) => void, workNative: () => FeatureContext['nativeContext'], expectsWork: boolean): Promise<FeatureActivation> {
  if (!context.browserServices) throw new Error('Collective requires the Host browser-service binding before start');
  const binding = await context.browserServices.getBinding('collective-client-api');
  await binding.assertCurrent();
  const origin = new URL(binding.origin), parent = new URL(binding.parentOrigin);
  if (origin.origin !== binding.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
    !origin.port || origin.port === '3001' || origin.port === '3002' || origin.username || origin.password ||
    parent.origin !== binding.parentOrigin || !['http:', 'https:'].includes(parent.protocol) || parent.username || parent.password ||
    binding.clientBuildId !== 'collective-client-v2' || !/^[a-f0-9]{64}$/.test(binding.assetDigest) ||
    Object.keys(binding.limits).length !== Object.keys(BROWSER_SERVICE_LIMITS).length ||
    Object.entries(BROWSER_SERVICE_LIMITS).some(([key, value]) => binding.limits[key as keyof typeof BROWSER_SERVICE_LIMITS] !== value)) throw new Error('Collective Host binding is invalid');
  const allowedHostOrigins = [binding.parentOrigin, binding.origin];
  const dataDirectory = join(context.dataDirectory, 'service');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider });
  const bootstrapSecretPath = join(dataDirectory, 'owner-bootstrap.secret');
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: provider,
    clientBuildId: binding.clientBuildId, humanAuthRedirectUri: binding.origin + '/api/auth/github/callback',
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapSecret = opened.store.getMetadata().bootstrapNeeded ? await readBootstrapSecret(bootstrapSecretPath) : undefined;
  if (!bootstrapSecret) await rm(bootstrapSecretPath, { force: true });
  const bootstrapLinkPath = join(dataDirectory, 'owner-bootstrap.url');
  if (bootstrapSecret) await writeBootstrapLink(bootstrapLinkPath, binding.origin + '#bootstrap=' + encodeURIComponent(bootstrapSecret));
  await binding.assertCurrent();
  let stopped = false;
  const assertActive = () => { if (stopped) throw new Error('Collective module is stopped'); void context.dataDirectory; };
  const verification = createCollectiveAgentVerification(context, assertActive, workNative);
  const connector = await CollectiveConnector.open({ dataDirectory: join(context.dataDirectory, 'connector'),
    verifyAgent: verification.verifyAgent, localTransport: createLocalServiceTransport(context.browserServices, binding, opened.store) });
  const contribution = declaration;
  const dispatch = createNodeHttpAdapter({ store: opened.store, allowedHostOrigins, bootstrapLinkPath, githubAppSetup }, binding, contribution);
  const native = await activateCollectivePublicNative(context, connector, assertActive);
  const background = new AbortController();
  let stopBackground: (() => Promise<void>) | undefined;
  const startBackground = (workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>) => {
    if (stopBackground) throw new Error('Collective background sync is already active');
    const current = async () => {assertActive();background.signal.throwIfAborted();await binding.assertCurrent();assertActive();};
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
  ready({connector, parentOrigin: binding.parentOrigin, assertActive, startBackground});
  if (!expectsWork) startBackground(async () => {});
  const localServiceStatus = (): CollectiveLocalServiceStatus => {
    const metadata = opened.store.getMetadata();
    return { state: metadata.onboardingComplete ? 'ready' : 'setup_required', serviceUrl: binding.origin, dataDirectory,
      serviceInstanceId: metadata.serviceInstanceId, bootstrapNeeded: metadata.bootstrapNeeded,
      ...(!metadata.onboardingComplete ? { setupStep: provider.readiness.ready ? 'owner_setup' as const : 'github_app' as const } : {}) };
  };
  if (!context.participantRoster || !context.ownerThreads) throw new Error('Collective owner roster/thread ports are required');
  const roster = context.participantRoster, threads = context.ownerThreads;
  const entry = createCollectiveEntryCaller({ connector, participantRoster: roster, contributionId: COLLECTIVE_NATIVE_ID,
    async assertCurrent() { assertActive(); await binding.assertCurrent(); assertActive(); } });
  const ownerControl = createOwnerControlHttp({ connector, binding, entry,
    reconsideration: native.reconsideration.reconsider,
    routeChange: createCollectiveOwnerRouteChange(context, connector, async () => { assertActive(); await binding.assertCurrent(); assertActive(); }),
    participation: createCollectiveOwnerParticipationChange(context, connector, async () => { assertActive(); await binding.assertCurrent(); assertActive(); }),
    view: createCollectiveOwnerView(context, connector, async () => { assertActive(); await binding.assertCurrent(); assertActive(); }),
    async reconcile(ownerUserId, connectionId, input) {
      const current = async () => { assertActive(); await binding.assertCurrent(); assertActive(); };
      const connection = await connector.getProjection(connectionId);
      const route = await connector.getHostRoute(connectionId); await current();
      if (route && route.localOwnerUserId !== ownerUserId) throw Object.assign(new Error('Connection belongs to another owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
      if (connection.authorityStatus !== 'connected' || !connection.authorizedHumanId) throw Object.assign(new Error('Collective participation authority is revoked'), { code: 'PARTICIPATION_REVOKED' });
      return createCollectiveParticipationCaller({ ownerUserId, contributionId: COLLECTIVE_NATIVE_ID, participantRoster: roster,
        ownerThreads: threads, connector, assertCurrent: current }).reconcile({ ...input, connectionId, route,
          initialExcludedCatIds: connection.initialExcludedCatIds });
    },
    assertActive() { if (stopped) throw new Error('Collective module is stopped'); void context.dataDirectory; },
    status: localServiceStatus,
    async launch() {
      const service = localServiceStatus();
      // Bootstrap is delivered only through the Host-authenticated control lane, never public status.
      const launchUrl = service.bootstrapNeeded
        ? binding.origin + '#bootstrap=' + encodeURIComponent(await readBootstrapSecret(bootstrapSecretPath)) : binding.origin;
      return { service, launchUrl };
    },
  });
  return {
    publicInvocationVerifier: native.publicInvocationVerifier,
    actions: {
      ...native.actions,
      'collective.connector.send': createCollectiveOwnerSendAction({ connector, roster, verification, assertActive }),
      ...createRecoveryActions(connector, binding),
      'collective.control.http': ownerControl,
      'collective.http.dispatch': async (input, native, caller) => {
        if (stopped || caller?.kind !== 'http') throw new Error('Collective HTTP context is required');
        return dispatch(input, native, caller);
      },
      'collective.service.status': async () => {
        if (stopped) throw new Error('Collective module is stopped');
        // Access is revoked by the same SDK session on disable.
        void context.dataDirectory;
        const metadata = opened.store.getMetadata();
        const setupState = metadata.bootstrapNeeded ? 'owner bootstrap required'
          : metadata.onboardingComplete ? 'onboarding complete' : 'onboarding pending';
        return { render: 'status', label: `Collective service running · ${setupState} · ${binding.origin}`,
          data: { state: 'running', url: binding.origin, ...metadata, connections: await connector.listConnections() } };
      },
    },
    async dispose() {
      stopped = true;
      background.abort();await stopBackground?.();

      if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    },
  };
}

export function createCollectivePluginModule(_options: CollectivePluginModuleOptions = {}): PluginModuleEntrypoint {
  return definePluginModule(manifest => {
    const plugin = definePlugin({ manifest });
    const declaration = plugin.manifest.contributions?.find((item): item is BrowserServiceContribution => item.type === 'browser-service' && item.id === 'collective-client-api');
    if (!declaration) throw new Error('Collective browser-service declaration is missing');
    let backend: WorkBackend | undefined;
    let workContext: FeatureContext['nativeContext'];
    return definePlugin({ manifest, activate: {
      'collective-backend': context => activateService(context, declaration, current => {backend = current;}, () => workContext,
        plugin.manifest.features.some(feature => feature.id === 'collective-work')),
      ...(plugin.manifest.features.some(feature => feature.id === 'collective-work') ? {
        'collective-work': async (context: FeatureContext) => {
          if (!backend) throw new Error('Collective backend must be active before Work');
          const activation = await activateCollectiveWork(context, backend);
          workContext = context.nativeContext;
          return {...activation, dispose: async () => {workContext = undefined;await activation.dispose?.();}};
        },
      } : {}),
    } });
  });
}

export default createCollectivePluginModule();
