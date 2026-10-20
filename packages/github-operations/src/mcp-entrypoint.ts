import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createRemoteTrackingMcpServer } from './tracking-mcp-server.js';

const server = createRemoteTrackingMcpServer(createModuleActionClient());
await server.connect(new StdioServerTransport());
