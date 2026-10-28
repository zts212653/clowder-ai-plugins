#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { resolveCollectivePublicUrl } from './cli-config.js';
import { GitHubAppManifestSetup } from './github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './github-human-auth-provider.js';
import { startCollectiveServer } from './http-server.js';
import { CollectiveServiceStore } from './store.js';
import { loadCollectiveClient } from '../../client-assets.js';
import { escrowBootstrapSecret, recoverBootstrapSecret, writeBootstrapLink } from './bootstrap-files.js';
import { createFileAttachmentOwner } from '../../attachment-owner/file-owner.js';
import { createConfiguredTranscriber } from '../../attachment-owner/local-transcriber.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`Usage: clowder-collective-service

Run the independent Collective Service and its matching Client.
Configuration (environment or a Node --env-file supplied by your service manager):
  COLLECTIVE_SERVICE_HOST                  loopback listener (default 127.0.0.1)
  COLLECTIVE_SERVICE_PORT                  listener port (default 5201)
  COLLECTIVE_SERVICE_PUBLIC_URL            canonical browser/tunnel address
  COLLECTIVE_SERVICE_DATA_DIR              persistent Service and attachment data
  COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS  comma-separated exact Café origins
  COLLECTIVE_STICKER_DATA_DIR              provisioned catalogue (default DATA_DIR/stickers)
  COLLECTIVE_STT_URL / COLLECTIVE_STT_MODEL optional existing loopback speech service and pinned model

Ready output names the private bootstrap-link file; the credential is never logged.
Stop with SIGTERM or SIGINT. Keep the same data directory on upgrade and restart.
`);
    return;
  }
  if (args.length) throw new Error('Unknown arguments; use --help for configuration');
  const host = process.env.COLLECTIVE_SERVICE_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('COLLECTIVE_SERVICE_HOST must be loopback');
  const port = parsePort(process.env.COLLECTIVE_SERVICE_PORT, 5201);
  if ([3001, 3002].includes(port)) throw new Error('Ports 3001 and 3002 are reserved for the Café runtime');
  const dataDirectory = resolveDataDirectory(process.env.COLLECTIVE_SERVICE_DATA_DIR);
  const allowedHostOrigins = parseOrigins(process.env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS);
  const publicUrl = resolveCollectivePublicUrl(process.env.COLLECTIVE_SERVICE_PUBLIC_URL, host, port);
  const transcribeAudio = createConfiguredTranscriber(process.env);
  const client = await loadCollectiveClient(new URL('../../../assets/client/', import.meta.url));
  // The standalone byte owner needs a matching decoder. Connector-only Host imports never load this native addon.
  await import('sharp');
  const humanAuthProvider = new ConfigurableGitHubHumanAuthProvider({
    clientId: process.env.COLLECTIVE_GITHUB_CLIENT_ID,
    clientSecret: process.env.COLLECTIVE_GITHUB_CLIENT_SECRET,
  });
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider: humanAuthProvider });
  const bootstrapSecretPath = resolve(dataDirectory, 'owner-bootstrap.secret');
  const bootstrapUrlPath = resolve(dataDirectory, 'owner-bootstrap.url');
  const stickerDirectory = resolve(process.env.COLLECTIVE_STICKER_DATA_DIR?.trim() || resolve(dataDirectory, 'stickers'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider,
    messageAttachmentOwner: createFileAttachmentOwner(resolve(dataDirectory, 'attachments'), {
      transcribeAudio,
      stickerDirectories: { memory: resolve(stickerDirectory, 'memory'), collaboration: resolve(stickerDirectory, 'collaboration') },
    }),
    humanAuthRedirectUri: new URL('/api/auth/github/callback', publicUrl).toString(),
    clientBuildId: client.clientBuildId,
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapNeeded = opened.store.getMetadata().bootstrapNeeded;
  const bootstrapLinkPath = bootstrapNeeded ? bootstrapUrlPath : undefined;
  if (bootstrapNeeded) {
    const secret = await recoverBootstrapSecret(bootstrapSecretPath, bootstrapUrlPath);
    await writeBootstrapLink(bootstrapUrlPath, `${publicUrl}#bootstrap=${encodeURIComponent(secret)}`);
  } else {
    await rm(bootstrapSecretPath, { force: true });
    await rm(bootstrapUrlPath, { force: true });
  }
  const running = await startCollectiveServer({
    store: opened.store,
    host,
    port,
    publicUrl,
    allowedHostOrigins,
    bootstrapLinkPath,
    githubAppSetup,
    clientAssets: client.files,
  });
  process.stdout.write(
    `${JSON.stringify({
      event: 'collective-service-ready',
      pid: process.pid,
      url: publicUrl,
      listenUrl: running.url,
      dataDirectory,
      serviceInstanceId: opened.store.serviceInstanceId,
      clientBuildId: opened.store.getMetadata().clientBuildId,
      bootstrapLinkPath,
    })}\n`,
  );
  const stop = async () => {
    await running.close();
    if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function resolveDataDirectory(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return resolve(homedir(), '.cat-cafe', 'collective-service');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('COLLECTIVE_SERVICE_PORT must be an integer between 0 and 65535');
  }
  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((origin) => {
      const url = new URL(origin.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('Allowed Host origins must be exact HTTP(S) origins without credentials, paths or fragments');
      return url.origin;
    })
    .filter((origin, index, all) => all.indexOf(origin) === index);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'collective-service-failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
