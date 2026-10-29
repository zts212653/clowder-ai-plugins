import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const wire = value => JSON.parse(JSON.stringify(value));

const contributions = [
  ['github-operations', 'github-tracking', 'cat_cafe_unregister_tracking', { subjectKey: 'pr:owner/repo#1' }],
  ['collective-connector', 'collective-native', 'cat_cafe_collective_current_context', {}],
  ['collective-connector', 'collective-owner-native', 'cat_cafe_collective_connector_send', { connectionId: 'connection', clientEventId: 'event', target: { kind: 'channel', channelId: 'general' }, body: 'fixture' }],
  ['collective-connector', 'collective-work-native', 'cat_cafe_collective_work_current_context', {}],
  ['music-generation', 'music-native', 'generate_music', { requestId: 'same-paid-request', outputPath: 'track.mp3', parameters: { prompt: 'fixture' } }],
];

for (const [pkg, id, toolName, args] of contributions) test(`${id}: request factory imports without process hooks and isolates action clients`, async () => {
  const root = resolve('packages', pkg);
  const manifest = parse(await readFile(resolve(root, 'plugin.yaml'), 'utf8'));
  const contribution = manifest.contributions.find(c => c.id === id && c.type === 'mcp');
  assert.ok(contribution.sharedFactory, 'the installable package must explicitly declare its factory');
  const require = createRequire(resolve(root, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { InMemoryTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/inMemory.js')));
  const before = process.eventNames().map(name => [name, process.listenerCount(name)]);
  const module = await import(pathToFileURL(resolve(root, contribution.sharedFactory.module.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))));
  assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), before);
  const factory = module[contribution.sharedFactory.export];
  assert.equal(typeof factory, 'function');
  const calls = [];
  const open = async identity => {
    const server = factory({ invoke: async (method, input) => { calls.push({ identity, method, input }); return { identity }; } });
    const client = new Client({ name: identity, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    return { server, client };
  };
  const a = await open('A'); const b = await open('B');
  try {
    assert.deepEqual(await a.client.listTools(), await b.client.listTools());
    const tools = (await a.client.listTools()).tools;
    assert.ok(tools.some(t => t.name === toolName));
    if (id === 'collective-native') {
      assert.ok(!tools.some(t => t.name === 'cat_cafe_collective_connector_send'));
      assert.ok(!tools.some(t => t.name === 'cat_cafe_collective_work_return_result'));
    }
    if (id !== 'collective-owner-native') {
      await Promise.all([a.client.callTool({ name: toolName, arguments: args }), b.client.callTool({ name: toolName, arguments: args })]);
      assert.deepEqual(calls.map(c => c.identity).sort(), ['A', 'B']);
    }
    await a.client.close();
    assert.ok((await b.client.listTools()).tools.length > 0, 'closing A cannot stop B or the business runtime');
  } finally { await a.client.close(); await b.client.close(); await a.server.close(); await b.server.close(); }
});


for (const [pkg, id, toolName, args] of contributions) test(`${id}: native stdio and the injected factory expose identical schemas, results and redacted errors`, async () => {
  const root = resolve('packages', pkg);
  const manifest = parse(await readFile(resolve(root, 'plugin.yaml'), 'utf8'));
  const contribution = manifest.contributions.find(c => c.id === id && c.type === 'mcp');
  const require = createRequire(resolve(root, 'package.json'));
  const sdk = async path => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)));
  const { Client } = await sdk('client/index.js');
  const { StdioClientTransport } = await sdk('client/stdio.js');
  const { InMemoryTransport } = await sdk('inMemory.js');
  const source = path => resolve(root, path.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
  const factory = (await import(pathToFileURL(source(contribution.sharedFactory.module))))[contribution.sharedFactory.export];
  let status = 200; let requests = 0;
  const http = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume without retaining credentials */ }
    requests++; response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { result: { retained: 'original business result' } } : { secret: 'must-not-leak' }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const direct = factory({ invoke: async () => {
    requests++;
    if (status !== 200) throw new Error(`Plugin action failed (HTTP ${status}); result may be unknown`);
    return { retained: 'original business result' };
  } });
  const memoryClient = new Client({ name: 'factory', version: '1' });
  const stdioClient = new Client({ name: 'stdio', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await direct.connect(b); await memoryClient.connect(a);
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    await stdioClient.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', source(contribution.runtime.entrypoint)], cwd: fileURLToPath(new URL('../', import.meta.url)), stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`,
        CLOWDER_PLUGIN_ACTION_TOKEN: 'activation', CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action', CAT_CAFE_INVOCATION_ID: 'inv', CAT_CAFE_CALLBACK_TOKEN: 'token' },
    }));
    assert.deepEqual(wire(await memoryClient.listTools()), wire(await stdioClient.listTools()));
    for (status of [200, 503]) {
      const first = await memoryClient.callTool({ name: toolName, arguments: args });
      const second = await stdioClient.callTool({ name: toolName, arguments: args });
      assert.deepEqual(wire(first), wire(second));
      assert.ok(!JSON.stringify(second).includes('must-not-leak'));
      assert.equal(first.isError, status === 200 ? undefined : true);
    }
    assert.equal(requests, 4, 'exactly one business invocation per request, including an unknown paid result');
  } finally { await memoryClient.close(); await stdioClient.close(); await direct.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
});

test('Collective keeps full Zod refinement and returns actual image blocks', async () => {
  const root = resolve('packages/collective-connector');
  const require = createRequire(resolve(root, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { InMemoryTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/inMemory.js')));
  const { createCollectiveMcpServer } = await import(pathToFileURL(resolve(root, 'src/mcp-server.ts')));
  let calls = 0;
  const image = { kind: 'collective_model_image', v: 1, attachmentId: 'att_12345678', sourceDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png', dataBase64: 'AAAA', width: 1, height: 1, originalWidth: 1, originalHeight: 1, transformed: false };
  const server = createCollectiveMcpServer({ invoke: async () => { calls++; return image; } });
  const client = new Client({ name: 'refinement', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const empty = await client.callTool({ name: 'cat_cafe_collective_submit_reply', arguments: { returnRef: 'r', replyOperationRef: 'o', body: '  ' } });
    assert.equal(empty.isError, true); assert.ok(empty.content[0].text.includes('A message needs text or content')); assert.equal(calls, 0);
    const result = await client.callTool({ name: 'cat_cafe_collective_read_context', arguments: { contextRef: 'context', image: { eventId: 'event', attachmentId: 'att_12345678' } } });
    assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: 'AAAA' });
    assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); }
});
