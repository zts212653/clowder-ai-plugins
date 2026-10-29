import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createMusicMcpServer } from './music-mcp-server.js';

await createMusicMcpServer(createModuleActionClient()).connect(new StdioServerTransport());
