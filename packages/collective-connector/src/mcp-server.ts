import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { collectivePublicNativeTools } from './public-native-methods.js';
import { collectiveNativeToolResult } from './collective-native-tool-result.js';

export interface CollectiveMcpClient {
  invoke(method: string, input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
}

export function createCollectiveMcpServer(client: CollectiveMcpClient): McpServer {
const server = new McpServer({ name: 'clowder-collective', version: '0.1.0' });
for (const tool of collectivePublicNativeTools) {
  // MCP normalizes object roots before JSON Schema conversion. Preserve the
  // object's fields there and enforce its complete refinement before dispatch.
  const inputSchema = tool.schema instanceof z.ZodEffects ? tool.schema.innerType() : tool.schema;
  server.registerTool(tool.name, { description: tool.description, inputSchema }, async (input: unknown, call: ModuleActionCallOptions) => {
    try {
      return collectiveNativeToolResult(tool.method, await client.invoke(tool.method, tool.schema.parse(input), call));
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Collective call failed' }] };
    }
  });
}
return server;
}
