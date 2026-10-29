import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createCollectiveOwnerMcpServer } from './owner-mcp-server.js';

await createCollectiveOwnerMcpServer(createModuleActionClient()).connect(new StdioServerTransport());
