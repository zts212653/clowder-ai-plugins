import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { analyzeVideo, type VideoAnalysisProviderConfig } from './protocol.js';

export function createVideoAnalysisMcpServer(config: VideoAnalysisProviderConfig): McpServer {
  const server = new McpServer({ name: 'clowder-video-analysis', version: '0.1.0' });
  server.registerTool(
    'video_analysis',
    {
      title: 'Video Analysis',
      description: 'Analyze one remote HTTPS video with the configured provider.',
      inputSchema: {
        videoUrl: z.url().startsWith('https://'),
        prompt: z.string().min(1),
        mimeType: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      try {
        const result = await analyzeVideo(config, input, extra.signal);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
  return server;
}
