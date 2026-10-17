#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRepoSyncMcpServer } from './mcp-server.mjs';
import { createProjectWorkspace } from './projects.mjs';

try {
  const file = process.env.REPO_SYNC_CONFIG_FILE;
  const projects = await createProjectWorkspace(file);
  const server = createRepoSyncMcpServer(null, { projects });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void server.close();
    });
  await server.connect(new StdioServerTransport());
} catch {
  console.error('[repo-sync] 插件无法启动，请检查私有配置与台账；未执行 Git 操作。');
  process.exitCode = 1;
}
