import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { collectModels } from '../plugins/tripo-studio/runtime/assets.mjs';
import { CdpConnection } from '../plugins/tripo-studio/runtime/cdp-connection.mjs';
import { wrapTool } from '../plugins/tripo-studio/runtime/tool-request.mjs';

function glb() {
  const json = Buffer.from('{"asset":{"version":"2.0"}}  ');
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}
test('real MCP cancellation stops the handler before later work executes', async (t) => {
  const server = new McpServer({ name: 'cancel-test', version: '1' });
  let started,
    completed = false;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  server.registerTool(
    'wait',
    { inputSchema: {} },
    wrapTool(async (_args, context) => {
      started();
      await delay(100, null, { signal: context?.signal });
      completed = true;
      return { completed };
    }),
  );
  const client = new Client({ name: 'cancel-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(right);
  await client.connect(left);
  const controller = new AbortController();
  const result = client.callTool({ name: 'wait', arguments: {} }, undefined, { signal: controller.signal });
  await running;
  controller.abort();
  await assert.rejects(result, /abort/i);
  await delay(150);
  assert.equal(completed, false);
});

test('one request budget bounds a serial batch and removes its incomplete downloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const focus = { focusedWindowId: 1, activeTabs: [] };
  const observations = [1, 2, 3].map((n) => ({
    v: 1,
    pageUrl: `https://studio.tripo3d.ai/3d-model/${n}1111111-1111-4111-8111-111111111111`,
    title: 'Train',
    observedAt: new Date().toISOString(),
    before: focus,
    after: focus,
    resources: ['https://tripo-data-public.rg1.data.tripo3d.com/train.glb'],
  }));
  let requests = 0;
  const tool = wrapTool(
    (_args, context) =>
      collectModels({ observations }, root, {
        signal: context?.signal,
        fetchAsset: async (_url, { signal }) => {
          requests++;
          await delay(30, null, { signal });
          return new Response(glb());
        },
      }),
    { timeoutMs: 50 },
  );
  const result = await tool({}, { signal: new AbortController().signal });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timeout|time.*out/i);
  assert.ok(requests < 3);
  assert.deepEqual(await readdir(root), []);
});

test('closing owned CDP rejects in-flight work without waiting for a socket close event', async (t) => {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  socket.send = () => {};
  socket.close = () => {};
  const cdp = new CdpConnection(socket);
  t.after(() => socket.dispatchEvent(new Event('close')));
  const pending = cdp.call('Runtime.evaluate');
  cdp.close();
  await assert.rejects(
    Promise.race([
      pending,
      delay(100).then(() => {
        throw new Error('COMMAND_STILL_PENDING');
      }),
    ]),
    /BROWSER_CLOSED/,
  );
});
