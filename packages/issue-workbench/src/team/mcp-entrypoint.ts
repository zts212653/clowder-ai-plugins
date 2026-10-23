import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';

// Embedded from the admitted manifest at build time: one schema/description source.
declare const ISSUE_TEAM_NATIVE_TOOLS: readonly (Tool & { method: string })[];
const tools = new Map(ISSUE_TEAM_NATIVE_TOOLS.map(tool => [tool.name, tool]));
const server = new Server({ name: 'clowder-issue-team', version: '0.1.0' }, { capabilities: { tools: {} } });
const client = createModuleActionClient();
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ISSUE_TEAM_NATIVE_TOOLS.map(({ method: _method, ...tool }) => tool),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, call) => {
  const tool = tools.get(request.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: 'Unknown Issue Workbench tool.' }] };
  try {
    const result = await client.invoke(tool.method, request.params.arguments ?? {}, call);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch {
    // Provider errors and callback credentials never enter the transcript.
    return { isError: true, content: [{ type: 'text', text: 'Issue Workbench action unavailable. Check plugin activation, current conversation and record permissions.' }] };
  }
});
await server.connect(new StdioServerTransport());
