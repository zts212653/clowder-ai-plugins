import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio MCP process invokes module action over HTTP and refreshes turn credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracking-stdio-'));
  const credentials = join(dir, 'credentials.json');
  const calls: { invocation: string | string[] | undefined; body: unknown }[] = [];
  const http = createServer(async (request, response) => {
    assert.equal(request.url, '/api/plugin-runtime/action');
    assert.equal(request.headers['x-clowder-plugin-action-token'], 'activation');
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ invocation: request.headers['x-invocation-id'], body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result: { generation: 1 } }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'installed-transport-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./mcp-entrypoint.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), stderr: 'inherit',
    env: { PATH: process.env.PATH ?? '', CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`,
      CAT_CAFE_CREDENTIAL_FILE: credentials, CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action' },
  });
  try {
    await writeFile(credentials, JSON.stringify({ invocationId: 'first', callbackToken: 'token1' }));
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 11);
    const args = { registrationId: 'stable', repoFullName: 'owner/repo', prNumber: 1 };
    assert.equal((await client.callTool({ name: 'cat_cafe_register_pr_tracking', arguments: args })).isError, undefined);
    await writeFile(credentials, JSON.stringify({ invocationId: 'next', callbackToken: 'token2' }));
    assert.equal((await client.callTool({ name: 'cat_cafe_register_pr_tracking', arguments: args })).isError, undefined);
    assert.deepEqual(calls, [
      { invocation: 'first', body: { method: 'github.typed-wait.register-pr', input: args } },
      { invocation: 'next', body: { method: 'github.typed-wait.register-pr', input: args } },
    ]);
    await writeFile(credentials, '{}');
    assert.equal((await client.callTool({ name: 'cat_cafe_unregister_tracking',
      arguments: { subjectKey: 'pr:owner/repo#1' } })).isError, true);
    assert.equal(calls.length, 2);
  } finally {
    await client.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true });
  }
});
