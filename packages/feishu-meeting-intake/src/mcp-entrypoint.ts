import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient, type ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';
import { meetingTools } from './native-methods.js';
const server = new McpServer({ name: 'clowder-meeting-records', version: '0.1.0' });
const client = createModuleActionClient();
for (const tool of meetingTools) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (input: unknown, call: ModuleActionCallOptions) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await client.invoke(tool.method, input, call)) }] }; }
  catch { return { isError: true, content: [{ type: 'text' as const, text: 'Meeting read unavailable: check record, account and current thread permissions.' }] }; }
});
await server.connect(new StdioServerTransport());
