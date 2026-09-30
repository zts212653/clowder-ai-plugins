import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { requireSafeProviderBaseUrl } from './protocol-engine/engine.js';
import { loadProtocolsFromDir } from './protocol-engine/loader.js';
import type { ProtocolTemplate, ProviderInstance } from './protocol-engine/types.js';
import { type VideoAnalysisProviderConfig } from './protocol.js';
import { buildProvider, createProtocolTools } from './protocol-tools.js';

function protocolsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'protocols');
}

export function buildVideoAnalysisProtocolToolConfig(
  config: VideoAnalysisProviderConfig,
  template: ProtocolTemplate,
): {
  readonly prefix: string;
  readonly provider: ProviderInstance;
  readonly template: ProtocolTemplate;
  readonly credentials: Record<string, string>;
} {
  const provider = buildProvider(config.provider, template, {
    baseUrl: config.baseUrl,
    model: config.model,
  });
  if (!provider.baseUrl) throw new TypeError(`Provider ${config.provider} has no base URL`);
  provider.baseUrl = requireSafeProviderBaseUrl(provider.baseUrl);
  const credentials: Record<string, string> = { apiKey: config.apiKey };
  if (template.auth?.paramName) credentials._authParamName = template.auth.paramName;
  return { prefix: 'video_analysis', provider, template, credentials };
}

export function createVideoAnalysisMcpServer(config: VideoAnalysisProviderConfig): McpServer {
  const templates = loadProtocolsFromDir(protocolsDirectory());
  const template = templates.get(config.provider);
  if (!template) throw new TypeError(`Unknown VIDEO_ANALYSIS_PROVIDER: ${config.provider}`);
  const server = new McpServer({ name: 'clowder-video-analysis', version: '0.1.0' });
  for (const tool of createProtocolTools(buildVideoAnalysisProtocolToolConfig(config, template))) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args, extra) => (
      tool.handler(args as never, extra) as never
    ));
  }
  return server;
}
