import { createServer, type Server } from 'node:http';
import type {CollectiveClientAssets} from '../../client-assets.js';
import type { GitHubAppManifestSetup } from './github-app-manifest-setup.js';
import { createCollectiveHttpHandler } from './http-router.js';
import type { CollectiveServiceStore } from './store.js';

export interface StartCollectiveServerOptions {
  readonly store: CollectiveServiceStore;
  readonly host?: string;
  readonly port?: number;
  /** Canonical browser-facing URL when TLS terminates before this listener. */
  readonly publicUrl?: string;
  readonly allowedHostOrigins?: readonly string[] | ReadonlySet<string>;
  readonly clientAssets?: CollectiveClientAssets;
  readonly bootstrapLinkPath?: string;
  readonly githubAppSetup?: GitHubAppManifestSetup;
}

export interface RunningCollectiveServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

const RESERVED_RUNTIME_PORTS = new Set([3001, 3002]);

export async function startCollectiveServer(options: StartCollectiveServerOptions): Promise<RunningCollectiveServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 5201;
  if (RESERVED_RUNTIME_PORTS.has(requestedPort)) {
    throw new Error(`Port ${requestedPort} is reserved for the Clowder AI runtime`);
  }
  const allowedHostOrigins = options.allowedHostOrigins instanceof Set ? options.allowedHostOrigins : new Set(options.allowedHostOrigins ?? []);
  const handler = createCollectiveHttpHandler({
    store: options.store,
    ...(options.publicUrl ? { serviceOrigin: new URL(options.publicUrl).origin } : {}),
    clientAssets: options.clientAssets,
    allowedHostOrigins,
    bootstrapLinkPath: options.bootstrapLinkPath,
    githubAppSetup: options.githubAppSetup,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Collective Service did not bind a TCP address');
  }
  const url = `http://${host}:${address.port}`;
  allowedHostOrigins.add(url);
  options.store.startArtifactOwnerRelay();
  return {
    host,
    port: address.port,
    url,
    server,
    close: () => {
      options.store.stopArtifactOwnerRelay();
      return closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
