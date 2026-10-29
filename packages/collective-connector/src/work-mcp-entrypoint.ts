import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createCollectiveWorkMcpServer } from './work-mcp-server.js';

await createCollectiveWorkMcpServer(createModuleActionClient()).connect(new StdioServerTransport());
