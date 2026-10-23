import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import test from 'node:test';
import { parse } from 'yaml';

const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
test('conversation tools have a declared native MCP route with Host-authenticated caller context', () => {
  const native = manifest.contributions.find(item => item.type === 'mcp' && item.id === 'issue-team-native');
  assert.ok(native, 'Generic Manager tool calls have no conversation caller; native MCP admission is required');
  assert.deepEqual(native.runtime, { transport: 'stdio', entrypoint: 'dist/team-mcp.js' });
  assert.ok(manifest.features[0].contributions.some(item => item.type === 'mcp' && item.id === native.id));
  assert.deepEqual(native.actions.map(item => item.method).sort(), manifest.contributions
    .filter(item => item.type === 'tool').map(item => item.action.method).sort());
});

test('packaged stdio entry uses fresh invocation credentials and only declared Host actions', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-native-'));
  const credentials = join(directory, 'turn.json');
  const calls = [];
  let refuse = false;
  const http = createServer(async (request, response) => {
    assert.equal(request.url, '/api/plugin-runtime/action');
    assert.equal(request.headers['x-clowder-plugin-action-token'], 'fixture-activation');
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push({ invocation: request.headers['x-invocation-id'], callback: request.headers['x-callback-token'], body: JSON.parse(raw) });
    response.setHeader('content-type', 'application/json');
    response.statusCode = refuse ? 403 : 200;
    response.end(JSON.stringify(refuse ? { error: 'private-fixture-provider-error' } : { result: { data: { received: true } } }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'issue-native-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.ISSUE_WORKBENCH_NATIVE_ENTRY ?? fileURLToPath(new URL('../dist/team-mcp.js', import.meta.url))],
    cwd: directory, stderr: 'inherit', env: { PATH: process.env.PATH ?? '',
      CAT_CAFE_API_URL: `http://127.0.0.1:${http.address().port}`, CAT_CAFE_CREDENTIAL_FILE: credentials,
      CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-activation', CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action' },
  });
  try {
    await writeFile(credentials, JSON.stringify({ invocationId: 'turn-1', callbackToken: 'callback-1' }));
    await client.connect(transport);
    const declared = manifest.contributions.filter(item => item.type === 'tool');
    assert.deepEqual((await client.listTools()).tools, declared.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    for (const [index, tool] of declared.entries()) {
      await writeFile(credentials, JSON.stringify({ invocationId: `turn-${index + 1}`, callbackToken: `callback-${index + 1}` }));
      const result = await client.callTool({ name: tool.name, arguments: { fixture: tool.name } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), { data: { received: true } });
      assert.deepEqual(calls[index], { invocation: `turn-${index + 1}`, callback: `callback-${index + 1}`,
        body: { method: tool.action.method, input: { fixture: tool.name } } });
    }
    assert.equal((await client.callTool({ name: 'not_declared', arguments: {} })).isError, true);
    assert.equal(calls.length, declared.length);
    await writeFile(credentials, '{}');
    assert.equal((await client.callTool({ name: 'issue_team_get', arguments: {} })).isError, true);
    assert.equal(calls.length, declared.length, 'expired turn never falls back to a previous credential');
    await writeFile(credentials, JSON.stringify({ invocationId: 'fresh', callbackToken: 'fresh-token' }));
    refuse = true;
    const denied = await client.callTool({ name: 'issue_team_get', arguments: {} });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /private-fixture-provider-error|fresh-token|fixture-activation/);
  } finally {
    await client.close();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
