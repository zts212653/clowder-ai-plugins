#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createVideoAnalysisMcpServer } from './mcp-server.js';
import { readVideoAnalysisProviderConfig } from './protocol.js';

export async function startVideoAnalysisMcp(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createVideoAnalysisMcpServer(readVideoAnalysisProviderConfig(environment));
  await server.connect(new StdioServerTransport());
}

const isEntryPoint = process.argv[1] !== undefined
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  startVideoAnalysisMcp().catch((error: unknown) => {
    console.error('[video-analysis] fatal:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
