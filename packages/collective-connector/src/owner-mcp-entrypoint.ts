import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createModuleActionClient, type ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';
import { collectiveOwnerNativeTools } from './owner-native-methods.js';

const server = new McpServer({ name: 'clowder-collective-owner', version: '0.1.0' });
const client = createModuleActionClient();
for (const tool of collectiveOwnerNativeTools) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (input: unknown, call: ModuleActionCallOptions) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await client.invoke(tool.method, input, call)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Collective call failed' }] }; }
  });
}
await server.connect(new StdioServerTransport());
