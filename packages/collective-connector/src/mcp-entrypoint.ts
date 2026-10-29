import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createCollectiveMcpServer } from './mcp-server.js';

await createCollectiveMcpServer(createModuleActionClient()).connect(new StdioServerTransport());
