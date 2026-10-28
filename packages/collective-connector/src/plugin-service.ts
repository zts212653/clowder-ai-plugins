import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { ConnectorProjection } from './business/connector/projection.js';
import type { CollectiveLocalTransport } from './business/connector/service-client.js';
import type { CollectiveMessageAttachmentOwnerPort } from './business/contracts/message-attachment-owner.js';
import { escrowBootstrapSecret, readBootstrapSecret, writeBootstrapLink } from './business/service/bootstrap-files.js';
import { GitHubAppManifestSetup } from './business/service/github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './business/service/github-human-auth-provider.js';
import { type RunningCollectiveServer, startCollectiveServer } from './business/service/http-server.js';
import { CollectiveServiceStore } from './business/service/store.js';
import { loadCollectiveClient } from './client-assets.js';
import { createLocalServiceTransport } from './local-service-transport.js';
import type { CollectiveLocalServiceStatus } from './owner-control-http.js';
import {
  createRemoteServiceStatusReader,
  type CollectiveRemoteServiceStatus,
  remoteServiceLabel,
  remoteServiceUrl,
} from './remote-service-status.js';

interface PluginService {
  readonly localTransport?: CollectiveLocalTransport;
  localStatus(): CollectiveLocalServiceStatus | undefined;
  remoteStatus?(connections: readonly ConnectorProjection[]): Promise<CollectiveRemoteServiceStatus>;
  statusAction(
    connections: readonly ConnectorProjection[],
  ): Promise<{ render: 'status'; label: string; data: Record<string, unknown> }>;
  launch(): Promise<{ service: CollectiveLocalServiceStatus; launchUrl: string }>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Mode selects composition only. The same Connector and the existing embedded Service keep their own data. */
export async function createPluginService(
  context: FeatureContext,
  allowedHostOrigins: Set<string>,
  assertActive: () => void,
  messageAttachmentOwner?: CollectiveMessageAttachmentOwnerPort,
): Promise<PluginService> {
  const mode = (await context.config.get('serviceMode')) || 'embedded';
  if (mode === 'remote') {
    const origin = remoteServiceUrl((await context.config.get('remoteServiceUrl')) ?? 'http://127.0.0.1:15201');
    const lifetime = new AbortController();
    const readStatus = createRemoteServiceStatusReader(origin, lifetime.signal);
    const remoteStatus = async (connections: readonly ConnectorProjection[]) => {
      assertActive();
      const status = await readStatus(connections);
      assertActive();
      return status;
    };
    return {
      localStatus: () => undefined,
      remoteStatus,
      async statusAction(connections) {
        const remoteService = await remoteStatus(connections);
        return {
          render: 'status',
          label: remoteServiceLabel(remoteService),
          data: { mode, remoteService, connections },
        };
      },
      async launch() {
        throw Object.assign(new Error('Remote mode does not create a local Service'), {
          code: 'COLLECTIVE_REMOTE_MODE',
        });
      },
      async start() {},
      async close() {
        lifetime.abort();
      },
    };
  }
  if (mode !== 'embedded') throw new Error('Unknown Collective serviceMode');
  const portValue = await context.config.get('servicePort');
  const port = portValue === undefined || portValue === '' ? 5201 : Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 3001 || port === 3002)
    throw new Error('Collective servicePort must be a non-reserved local port (1024–65535)');
  const origin = `http://127.0.0.1:${port}`;
  allowedHostOrigins.add(origin);
  const client = await loadCollectiveClient(new URL('../assets/client/', import.meta.url));
  const dataDirectory = join(context.dataPath, 'service');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider });
  const bootstrapSecretPath = join(dataDirectory, 'owner-bootstrap.secret');
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: provider,
    messageAttachmentOwner,
    clientBuildId: client.clientBuildId,
    humanAuthRedirectUri: origin + '/api/auth/github/callback',
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapSecret = opened.store.getMetadata().bootstrapNeeded
    ? await readBootstrapSecret(bootstrapSecretPath)
    : undefined;
  if (!bootstrapSecret) await rm(bootstrapSecretPath, { force: true });
  const bootstrapLinkPath = join(dataDirectory, 'owner-bootstrap.url');
  if (bootstrapSecret)
    await writeBootstrapLink(bootstrapLinkPath, origin + '#bootstrap=' + encodeURIComponent(bootstrapSecret));
  let server: RunningCollectiveServer | undefined;
  const localStatus = (): CollectiveLocalServiceStatus => {
    const metadata = opened.store.getMetadata();
    return {
      state: metadata.onboardingComplete ? 'ready' : 'setup_required',
      serviceUrl: origin,
      dataDirectory,
      serviceInstanceId: metadata.serviceInstanceId,
      bootstrapNeeded: metadata.bootstrapNeeded,
      ...(!metadata.onboardingComplete
        ? ({ setupStep: provider.readiness.ready ? 'owner_setup' : 'github_app' } as const)
        : {}),
    };
  };
  return {
    localTransport: createLocalServiceTransport(origin, assertActive, opened.store),
    localStatus,
    async statusAction(connections) {
      assertActive();
      const metadata = opened.store.getMetadata();
      const setupState = metadata.bootstrapNeeded
        ? 'owner bootstrap required'
        : metadata.onboardingComplete
          ? 'onboarding complete'
          : 'onboarding pending';
      return {
        render: 'status',
        label: `Collective service running · ${setupState} · ${origin}${!metadata.onboardingComplete ? ' · Open Collective to finish account setup and pair a connection.' : ''}`,
        data: { state: 'running', url: origin, ...metadata, connections },
      };
    },
    async launch() {
      assertActive();
      const service = localStatus();
      return {
        service,
        launchUrl: service.bootstrapNeeded
          ? origin + '#bootstrap=' + encodeURIComponent(await readBootstrapSecret(bootstrapSecretPath))
          : origin,
      };
    },
    async start() {
      server = await startCollectiveServer({
        store: opened.store,
        port,
        allowedHostOrigins,
        bootstrapLinkPath,
        githubAppSetup,
        clientAssets: client.files,
      });
    },
    async close() {
      await server?.close();
      if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    },
  };
}
