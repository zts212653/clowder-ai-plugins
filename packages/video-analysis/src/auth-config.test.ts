import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVideoAnalysisMcpServer } from './mcp-server.js';
import { readVideoAnalysisProviderConfig } from './protocol.js';

test('saved authentication mode reaches the migrated MCP provider request', async () => {
  const observed: Array<{ url: URL; authorization: string | undefined }> = [];
  const http = createServer((request, response) => {
    observed.push({ url: new URL(request.url!, 'http://fixture'), authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  try {
    for (const authType of ['apikey', 'query-param']) {
      const settings: Record<string, string> = { provider: 'gemini', authType, apiKey: 'isolated-key', baseUrl: `http://127.0.0.1:${address.port}` };
      const environment = Object.fromEntries(Object.entries(manifest.contributions[0].environment as Record<string, { key: string }>).map(([key, binding]) => [key, settings[binding.key]]));
      const server = createVideoAnalysisMcpServer(readVideoAnalysisProviderConfig(environment));
      const client = new Client({ name: 'original-settings-fixture', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({ name: 'video_analysis_execute', arguments: { capability: 'analyze_url', vars: { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' } } });
        assert.notEqual(result.isError, true);
        const request = observed.at(-1)!;
        assert.equal(request.authorization, authType === 'apikey' ? 'Bearer isolated-key' : undefined);
        assert.equal(request.url.searchParams.get('key'), authType === 'query-param' ? 'isolated-key' : null);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
