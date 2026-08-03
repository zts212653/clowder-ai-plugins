import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  createStackChanStreamableHttpMcpCaller,
  type StackChanMcpClientLike,
} from './mcp-transport.js';

test('connects to the loopback gateway with bearer auth and forwards bounded tool calls', async () => {
  const connected: unknown[] = [];
  const calls: unknown[] = [];
  const closed: string[] = [];
  const transports: unknown[] = [];
  const client: StackChanMcpClientLike = {
    async connect(transport): Promise<void> {
      connected.push(transport);
    },
    async callTool(params, _schema, options): Promise<unknown> {
      calls.push({ params, options });
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    async close(): Promise<void> {
      closed.push('closed');
    },
  };
  const caller = createStackChanStreamableHttpMcpCaller({
    endpointUrl: 'http://127.0.0.1:8767/mcp',
    token: '0123456789abcdef',
    requestTimeoutMs: 12_000,
    createClient: () => client,
    createTransport(url, options) {
      const transport = { url: url.toString(), options };
      transports.push(transport);
      return transport;
    },
  });

  await assert.rejects(
    caller.callTool('listen', { duration_ms: 5_000 }),
    /not connected/i,
  );

  await Promise.all([caller.connect(), caller.connect()]);
  assert.equal(connected.length, 1);
  assert.deepEqual(transports, [
    {
      url: 'http://127.0.0.1:8767/mcp',
      options: {
        requestInit: {
          headers: { Authorization: 'Bearer 0123456789abcdef' },
        },
      },
    },
  ]);

  const controller = new AbortController();
  assert.deepEqual(
    await caller.callTool(
      'listen',
      { duration_ms: 5_000 },
      { signal: controller.signal },
    ),
    { content: [{ type: 'text', text: '{"ok":true}' }] },
  );
  assert.deepEqual(calls, [
    {
      params: { name: 'listen', arguments: { duration_ms: 5_000 } },
      options: { signal: controller.signal, timeout: 12_000 },
    },
  ]);

  await Promise.all([caller.close(), caller.close()]);
  assert.deepEqual(closed, ['closed']);
});

test('rejects remote, credential-bearing, and unauthenticated gateway URLs', () => {
  const base = {
    token: '0123456789abcdef',
    createClient: () => ({
      async connect(): Promise<void> {},
      async callTool(): Promise<unknown> {
        return {};
      },
      async close(): Promise<void> {},
    }),
    createTransport: () => ({}),
  };

  assert.throws(
    () =>
      createStackChanStreamableHttpMcpCaller({
        ...base,
        endpointUrl: 'http://192.168.1.20:8767/mcp',
      }),
    /loopback/i,
  );
  assert.throws(
    () =>
      createStackChanStreamableHttpMcpCaller({
        ...base,
        endpointUrl: 'http://user:password@127.0.0.1:8767/mcp',
      }),
    /credentials/i,
  );
  assert.throws(
    () =>
      createStackChanStreamableHttpMcpCaller({
        ...base,
        endpointUrl: 'http://127.0.0.1:8767/mcp',
        token: '',
      }),
    /token/i,
  );
});

test('does not poison the daemon after one rejected tool call', async () => {
  let attempts = 0;
  const caller = createStackChanStreamableHttpMcpCaller({
    endpointUrl: 'http://127.0.0.1:8767/mcp',
    token: '0123456789abcdef',
    createClient: () => ({
      async connect(): Promise<void> {},
      async callTool(): Promise<unknown> {
        attempts += 1;
        if (attempts === 1) throw new Error('transient timeout');
        return { ok: true };
      },
      async close(): Promise<void> {},
    }),
    createTransport: () => ({}),
  });

  await caller.connect();
  await assert.rejects(caller.callTool('say', {}), /transient timeout/i);
  assert.equal(caller.status(), 'online');
  assert.deepEqual(await caller.callTool('say', {}), { ok: true });
  assert.equal(attempts, 2);
});

test('reports a stale MCP session as degraded and reconnects on the next tool call', async () => {
  let generation = 0;
  const connected: number[] = [];
  const closed: number[] = [];
  const caller = createStackChanStreamableHttpMcpCaller({
    endpointUrl: 'http://127.0.0.1:8767/mcp',
    token: '0123456789abcdef',
    createClient: () => {
      generation += 1;
      const current = generation;
      return {
        async connect(): Promise<void> {
          connected.push(current);
        },
        async callTool(): Promise<unknown> {
          if (current === 1) {
            throw new StreamableHTTPError(404, 'session expired');
          }
          return { generation: current };
        },
        async close(): Promise<void> {
          closed.push(current);
        },
      };
    },
    createTransport: () => ({}),
  });

  await caller.connect();
  await assert.rejects(caller.callTool('status', {}), /session expired/i);
  assert.equal(caller.status(), 'degraded');

  assert.deepEqual(await caller.callTool('status', {}), { generation: 2 });
  assert.equal(caller.status(), 'online');
  assert.deepEqual(connected, [1, 2]);
  assert.deepEqual(closed, [1]);

  await caller.close();
  assert.deepEqual(closed, [1, 2]);
});
