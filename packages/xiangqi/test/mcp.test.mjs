import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INITIAL_FEN } from '../src/rules.mjs';
import { createXiangqiMcpServer } from '../src/mcp-server.mjs';

test('installed MCP contribution exposes position and game tools with no identity arguments', async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createXiangqiMcpServer();
  const client = new Client({ name: 'fixture-host', version: '0.1.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'xiangqi_analyze_position',
      'xiangqi_legal_moves',
      'xiangqi_open_game',
      'xiangqi_play_move',
      'xiangqi_read_game',
    ]);
    for (const tool of listed.tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      assert.equal(properties.includes('catId'), false);
      assert.equal(properties.includes('threadId'), false);
      assert.equal(properties.includes('dataRoot'), false);
    }
    const legal = await client.callTool({ name: 'xiangqi_legal_moves', arguments: { fen: INITIAL_FEN } });
    const result = JSON.parse(legal.content[0].text);
    assert.equal(result.moves.length, 44);
    const report = await client.callTool({
      name: 'xiangqi_analyze_position',
      arguments: { fen: INITIAL_FEN, timeMs: 30, maxDepth: 2 },
    });
    assert.equal(JSON.parse(report.content[0].text).safetyComplete, true);
    const invalid = await client.callTool({ name: 'xiangqi_legal_moves', arguments: { fen: 'bad' } });
    assert.equal(invalid.isError, true);
    const forced = await client.callTool({
      name: 'xiangqi_analyze_position',
      arguments: { fen: '3Rk4/4R4/9/9/9/9/9/9/9/4K4 b - - 0 1', timeMs: 100, maxDepth: 2 },
    });
    assert.deepEqual(JSON.parse(forced.content[0].text).candidates.map((move) => move.ucci), ['e9d9']);
    const terminal = await client.callTool({
      name: 'xiangqi_analyze_position',
      arguments: { fen: '3RkR3/4R4/9/9/9/9/9/9/9/4K4 b - - 0 1', timeMs: 100, maxDepth: 2 },
    });
    const ended = JSON.parse(terminal.content[0].text);
    assert.deepEqual(ended.terminal, { status: 'checkmate', winner: 'red' });
    assert.deepEqual(ended.candidates, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('game tools preserve native turn metadata and expose only the authenticated Host launcher', async t => {
  const calls = [], gameId = `game_${'a'.repeat(32)}`;
  const launchPath = `/api/plugins/dev.clowder.xiangqi/board/${gameId}`;
  const server = createXiangqiMcpServer({ apiUrl: 'http://127.0.0.1:3216', actionClient: {
    async invoke(method, input, options) {
      calls.push({ method, input, meta: options._meta });
      assert.equal(options.signal instanceof AbortSignal, true);
      return method === 'xiangqi.open' ? { gameId, revision: 0, launchPath } : { gameId, revision: 2 };
    },
  } });
  const client = new Client({ name: 'native-carrier-fixture', version: '1' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const meta = { threadId: 'native-thread', 'x-codex-turn-metadata': { thread_id: 'native-thread', turn_id: 'native-turn' } };
  const opened = await client.callTool({ name: 'xiangqi_open_game', arguments: {}, _meta: meta });
  assert.equal(JSON.parse(opened.content[0].text).url, `http://127.0.0.1:3216${launchPath}`);
  assert.equal(opened.content[0].text.includes('#session='), false);
  await client.callTool({ name: 'xiangqi_read_game', arguments: { gameId, revision: 1 }, _meta: meta });
  await client.callTool({ name: 'xiangqi_play_move', arguments: { gameId, revision: 1, move: 'b9c7' }, _meta: meta });
  assert.deepEqual(calls.map(call => call.method), ['xiangqi.open', 'xiangqi.read', 'xiangqi.play']);
  assert.equal(calls.every(call => JSON.stringify(call.meta) === JSON.stringify(meta)), true);
  assert.deepEqual(calls[2].input, { gameId, revision: 1, move: 'b9c7' });
});

test('the actual stdio entrypoint starts through an installed binary symlink', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'xiangqi-mcp-bin-'));
  const alias = join(root, 'clowder-xiangqi-mcp.mjs');
  symlinkSync(fileURLToPath(new URL('../src/mcp-entrypoint.mjs', import.meta.url)), alias);
  const client = new Client({ name: 'installed-binary-consumer', version: '1' }, { capabilities: {} });
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [alias], env: { PATH: process.env.PATH }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 5);
  const result = await client.callTool({ name: 'xiangqi_legal_moves', arguments: { fen: INITIAL_FEN } });
  assert.equal(JSON.parse(result.content[0].text).moves.length, 44);
  assert.equal((await client.callTool({ name: 'xiangqi_open_game', arguments: {} })).isError, true);
});
