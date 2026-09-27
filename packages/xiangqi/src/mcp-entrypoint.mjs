#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXiangqiMcpServer } from './mcp-server.mjs';

export async function startXiangqiMcp() {
  const server = createXiangqiMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  startXiangqiMcp().catch((error) => {
    console.error('[xiangqi] fatal:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
