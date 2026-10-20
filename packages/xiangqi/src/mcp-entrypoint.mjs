#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXiangqiMcpServer } from './mcp-server.mjs';

export async function startXiangqiMcp() {
  const server = createXiangqiMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  startXiangqiMcp().catch((error) => {
    console.error('[xiangqi] fatal:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
