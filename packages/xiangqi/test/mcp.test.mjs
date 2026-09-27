import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INITIAL_FEN } from '../src/rules.mjs';
import { createXiangqiMcpServer } from '../src/mcp-server.mjs';

test('installed MCP contribution exposes only position tools with no identity arguments', async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createXiangqiMcpServer();
  const client = new Client({ name: 'fixture-host', version: '0.1.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'xiangqi_analyze_position',
      'xiangqi_legal_moves',
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
