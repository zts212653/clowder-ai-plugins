import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  analyzeVideo,
  createVideoAnalysisMcpServer,
  type VideoAnalysisProviderConfig,
} from './index.js';

async function fixtureServer(
  handler: (request: { url: URL; authorization?: string; body: unknown }) => {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: unknown;
  },
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = handler({
        url: new URL(request.url ?? '/', `http://${request.headers.host}`),
        authorization: request.headers.authorization,
        body,
      });
      response.statusCode = result.status ?? 200;
      response.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('executes Gemini and Zhipu request shapes through the migrated package', async () => {
  const observed: Array<{ url: URL; authorization?: string; body: unknown }> = [];
  const fixture = await fixtureServer((request) => {
    observed.push(request);
    return {
      body: request.url.pathname.includes('generateContent')
        ? { candidates: [{ content: { parts: [{ text: '{"summary":"gemini"}' }] } }] }
        : { choices: [{ message: { content: '{"summary":"zhipu"}' } }] },
    };
  });
  try {
    const base = { apiKey: 'test-secret', baseUrl: fixture.baseUrl };
    assert.equal(
      await analyzeVideo(
        { ...base, provider: 'gemini' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      '{"summary":"gemini"}',
    );
    assert.equal(
      await analyzeVideo(
        { ...base, provider: 'zhipu' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      '{"summary":"zhipu"}',
    );

    assert.equal(observed[0]?.url.searchParams.get('key'), 'test-secret');
    assert.equal(observed[0]?.authorization, undefined);
    assert.equal(observed[1]?.authorization, 'Bearer test-secret');
    assert.match(JSON.stringify(observed[0]?.body), /fileUri/);
    assert.match(JSON.stringify(observed[1]?.body), /video_url/);
  } finally {
    await fixture.close();
  }
});

test('scrubs credentials from provider errors', async () => {
  const secret = 'top-secret-api-key';
  const fixture = await fixtureServer(() => ({ body: { error: `rejected ${secret}` } }));
  try {
    await assert.rejects(
      analyzeVideo(
        { provider: 'gemini', apiKey: secret, baseUrl: fixture.baseUrl },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /\*\*\*/);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('scrubs request credentials without retaining an unsafe cause chain', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'top secret!~';
  globalThis.fetch = async (input) => {
    throw new Error(`request failed for ${String(input)}`);
  };

  try {
    await assert.rejects(
      analyzeVideo(
        { provider: 'gemini', apiKey: secret, baseUrl: 'http://127.0.0.1' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /top\+secret%21%7E/);
        assert.match(error.message, /\*\*\*/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scrubs invalid JSON without retaining the raw parser cause', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'top-secret-parser-key';
  globalThis.fetch = async () => new Response(
    `{"leaked":"${secret}"`,
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  try {
    await assert.rejects(
      analyzeVideo(
        { provider: 'gemini', apiKey: secret, baseUrl: 'http://127.0.0.1' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /\*\*\*/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries the migrated transient-status set and honors provider retry-after', async () => {
  let attempts = 0;
  const fixture = await fixtureServer(() => {
    attempts += 1;
    return attempts < 3
      ? { status: 503, headers: { 'retry-after': '0' }, body: { error: 'transient' } }
      : { body: { candidates: [{ content: { parts: [{ text: 'recovered' }] } }] } };
  });
  try {
    const result = await analyzeVideo(
      { provider: 'gemini', apiKey: 'test-secret', baseUrl: fixture.baseUrl },
      { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
    );
    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  } finally {
    await fixture.close();
  }
});

test('retries a transient response when streaming its body fails', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('stream disconnected'));
          },
        }),
        { status: 503, headers: { 'retry-after': '0' } },
      );
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    assert.equal(
      await analyzeVideo(
        { provider: 'gemini', apiKey: 'test-secret', baseUrl: 'http://127.0.0.1' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
        AbortSignal.timeout(500),
      ),
      'recovered',
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('honors the HTTP-date form of retry-after', async () => {
  let attempts = 0;
  const fixture = await fixtureServer(() => {
    attempts += 1;
    return attempts === 1
      ? {
          status: 503,
          headers: { 'retry-after': new Date(0).toUTCString() },
          body: { error: 'transient' },
        }
      : { body: { candidates: [{ content: { parts: [{ text: 'recovered' }] } }] } };
  });
  try {
    const result = await analyzeVideo(
      { provider: 'gemini', apiKey: 'test-secret', baseUrl: fixture.baseUrl },
      { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      AbortSignal.timeout(500),
    );
    assert.equal(result, 'recovered');
    assert.equal(attempts, 2);
  } finally {
    await fixture.close();
  }
});

test('cancels an oversized provider body before buffering the full stream', async () => {
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024);
  let attempts = 0;
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
          if (pulls === 9) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    await assert.rejects(
      analyzeVideo(
        { provider: 'gemini', apiKey: 'test-secret', baseUrl: 'http://127.0.0.1' },
        { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
      ),
      /provider response exceeded 4194304 bytes/,
    );
    assert.equal(attempts, 1);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 6, `expected cancellation at the first over-limit read, received ${pulls} pulls`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exposes one deterministic MCP tool over the public MCP transport', async () => {
  const fixture = await fixtureServer(() => ({
    body: { candidates: [{ content: { parts: [{ text: 'done' }] } }] },
  }));
  const config: VideoAnalysisProviderConfig = {
    provider: 'gemini',
    apiKey: 'test-secret',
    baseUrl: fixture.baseUrl,
  };
  const server = createVideoAnalysisMcpServer(config);
  const client = new Client({ name: 'video-analysis-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['video_analysis']);
    const result = await client.callTool({
      name: 'video_analysis',
      arguments: { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
  } finally {
    await client.close();
    await server.close();
    await fixture.close();
  }
});
