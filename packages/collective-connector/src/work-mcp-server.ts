import type { CollectiveMcpClient } from './mcp-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';
import { collectiveWorkNativeTools } from './work-native-methods.js';
export function createCollectiveWorkMcpServer(client: CollectiveMcpClient): McpServer {
const server = new McpServer({name: 'clowder-collective-work', version: '0.1.0'});
for (const tool of collectiveWorkNativeTools) {
  server.registerTool(tool.name, {description: tool.description, inputSchema: tool.schema}, async (input: unknown, call: ModuleActionCallOptions) => {
    try {return {content: [{type: 'text' as const, text: JSON.stringify(await client.invoke(tool.method, input, call))}]};}
    catch (error) {return {isError: true, content: [{type: 'text' as const, text: error instanceof Error ? error.message : 'Collective Work call failed'}]};}
  });
}
return server;
}
