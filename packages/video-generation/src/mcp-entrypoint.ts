#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadProtocolsFromDir } from './protocol-engine/loader.js';
import { requireSafeProviderBaseUrl } from './protocol-engine/engine.js';
import type { ProtocolTemplate, ProviderInstance } from './protocol-engine/types.js';
import {
  buildCredentialsFromEnv,
  buildProviderFromEnv,
  createProtocolTools,
} from './protocol-tools.js';

const ENV_PREFIX = 'VIDEO_GEN';

function protocolsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'protocols');
}

export function buildProtocolToolConfig(
  provider: ProviderInstance,
  template: ProtocolTemplate,
) {
  const credentials = buildCredentialsFromEnv(ENV_PREFIX);
  if (template.auth?.paramName) credentials._authParamName = template.auth.paramName;
  return { prefix: 'video_gen', provider, template, credentials };
}

export async function startVideoGenerationServer(): Promise<void> {
  const templates = loadProtocolsFromDir(protocolsDirectory());
  const providerName = process.env.VIDEO_GEN_PROVIDER;
  const selectedTemplate = providerName ? templates.get(providerName) : undefined;
  const provider = buildProviderFromEnv(
    ENV_PREFIX,
    selectedTemplate?.baseUrl,
    selectedTemplate?.auth?.method,
  );

  const server = new McpServer({ name: 'clowder-video-generation', version: '0.1.0-alpha.0' });
  if (provider) {
    const template = templates.get(provider.protocol);
    if (!template) throw new Error(`Unknown VIDEO_GEN_PROVIDER: ${provider.protocol}`);
    if (!provider.baseUrl) throw new Error(`Provider ${provider.protocol} has no base URL`);
    provider.baseUrl = requireSafeProviderBaseUrl(provider.baseUrl);
    for (const tool of createProtocolTools(buildProtocolToolConfig(provider, template))) {
      server.tool(tool.name, tool.description, tool.inputSchema, async (args, extra) => {
        return tool.handler(args as never, extra) as never;
      });
    }
  }
  await server.connect(new StdioServerTransport());
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  startVideoGenerationServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'video-generation startup failed';
    console.error(`[video-generation] ${message}`);
    process.exitCode = 1;
  });
}
