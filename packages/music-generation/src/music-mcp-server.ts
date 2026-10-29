import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';

export const musicTool = {
  name: 'generate_music',
  description: 'Generate background music / 配乐 through the enabled Google Cloud music plugin. Use when: a film or game needs an instrumental soundtrack or song. NOT for: speech, transcription, AI Studio prepaid credits or Flow Music browser subscription usage. Output: one billed generation and a new project-local MP3 plus provenance, or a structured pending/refused/unknown result. GOTCHA: use the same requestId and exact arguments when polling or recovering delivery; a different requestId starts a new paid operation. Never automatically replace unknown work. Cloud OAuth, plugin enablement and the current project output grant are separate; actual charges and Ultra credit deduction remain unverified.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'outputPath', 'parameters'], properties: {
    requestId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$', description: 'Stable unique identity for this intentional generation, retained unchanged when polling or recovering delivery.' },
    outputPath: { type: 'string', minLength: 1, maxLength: 4096, description: 'New relative .mp3 path in the current calling project. Existing audio or provenance is refused before generation.' },
    parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Music style, mood and instruments.' },
      model: { enum: ['lyria-3-clip-preview', 'lyria-3-pro-preview'], default: 'lyria-3-clip-preview' },
      instrumental: { type: 'boolean', default: true },
      durationSeconds: { type: 'integer', minimum: 5, maximum: 180, description: 'Prompt intent, not measured duration; Clip permits only 30 or omission.' },
      bpm: { type: 'integer', minimum: 20, maximum: 300 },
    } },
  } },
};


export function createMusicMcpServer(client: {
  invoke(method: string, input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
}): Server {
  const server = new Server({ name: 'google-cloud-music', version: '0.1.0-alpha.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [musicTool] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, call) => {
    if (request.params.name !== musicTool.name) throw new McpError(ErrorCode.MethodNotFound, 'Unknown music tool method');
    try {
      const response = await client.invoke('music.output', request.params.arguments, call);
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Music action was refused or its result is unknown. Check the plugin card; do not create a replacement paid request.' }] };
    }
  });
  return server;
}
