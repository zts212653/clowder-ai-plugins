import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '../src/connections.mjs';
import { createRepoSyncMcpServer } from '../src/mcp-server.mjs';

test('MCP boots with no private JSON, and reports operator configuration without exposing local fields', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'repo-sync-mcp-setup-')), 'private.json');
  const connection = await createConnection(file);
  const server = createRepoSyncMcpServer(null, { connection });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'first-use-host', version: '0.1.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const status = () => client.callTool({ name: 'repo_sync_status', arguments: {} });
    assert.equal(JSON.parse((await status()).content[0].text).configured, false);
    await assert.rejects(access(file), { code: 'ENOENT' });
    await connection.save({
      mode: 'version',
      sourceUrl: 'https://github.com/demo/core.git',
      internalUrl: 'git@codehub.example:team/core.git',
      sourceBranch: 'main',
      targetBranch: 'main',
      internalPaths: [],
      mergePaths: [],
      expectedRevision: null,
      commitClosureVerified: false,
    });
    const configured = (await status()).content[0].text;
    assert.equal(JSON.parse(configured).configured, true);
    assert.doesNotMatch(configured, /codehub|private.json|sourceUrl|stateDir/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP exposes bounded status and explicit local workbench only, never Git writing tools', async () => {
  let reads = 0;
  const receiver = {
    config: {
      mode: 'version',
      sourceUrl: 'https://private.example/source',
      internalUrl: 'https://private.example/internal',
    },
    status: async () => {
      reads++;
      return {
        accepted: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40), privateDetail: 'private fixture detail' },
        queue: [],
        events: [{ message: 'sensitive fixture text' }],
        templates: { body: 'private body' },
      };
    },
  };
  const server = createRepoSyncMcpServer(receiver);
  assert.equal(reads, 0, 'plugin boot does not inspect repositories or start reception');
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-host', version: '0.1.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['repo_sync_open_workbench', 'repo_sync_status']);
    assert.ok(tools.every((tool) => Object.keys(tool.inputSchema.properties ?? {}).length === 0));
    const status = await client.callTool({ name: 'repo_sync_status', arguments: {} });
    assert.doesNotMatch(status.content[0].text, /private|sensitive|template|sourceUrl/);
    const first = JSON.parse(
      (await client.callTool({ name: 'repo_sync_open_workbench', arguments: {} })).content[0].text,
    );
    const second = JSON.parse(
      (await client.callTool({ name: 'repo_sync_open_workbench', arguments: {} })).content[0].text,
    );
    assert.equal(first.url, second.url);
    assert.equal(new URL(first.url).hostname, '127.0.0.1');
    assert.equal((await fetch(first.url)).status, 200);
    await client.close();
    await assert.rejects(() => fetch(first.url));
  } finally {
    await client.close();
    await server.close();
  }
});
