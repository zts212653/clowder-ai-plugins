import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('session/new and session/load forward fresh MCP specs to each native Pi subprocess', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-pi-acp-'));
  const fixture = fileURLToPath(new URL('./fake-pi.cjs', import.meta.url));
  const command = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await writeFile(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
    { mode: 0o700 },
  );
  const capture = join(root, 'capture.json');
  const child = spawn(
    process.execPath,
    [process.env.PI_ACP_TEST_ENTRY ?? fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        PI_ACP_DIR: join(root, 'state'),
        PI_ACP_PI_COMMAND: command,
        PI_ACP_CAPTURE: capture,
        PI_ACP_SESSION_FILE: join(root, 'session.jsonl'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  t.after(async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill();
        resolve();
      }, 2000).unref();
    });
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  let buffer = '',
    sequence = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      if (response.id) pending.get(response.id)?.(response);
    }
  });
  child.stderr.resume();
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(Error(`Timeout ${method}`)), 10000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        response.error ? reject(Error(JSON.stringify(response.error))) : resolve(response.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const initialized = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  });
  assert.equal(initialized.agentCapabilities.sessionCapabilities.delete, undefined);
  const servers = [
    {
      name: 'cat-cafe-collab',
      command: process.execPath,
      args: ['collab.js'],
      env: [{ name: 'CALLBACK_FILE', value: 'fresh-1' }],
    },
  ];
  const session = await request('session/new', {
    cwd: root,
    mcpServers: servers,
  });
  const history = join(root, 'session.jsonl');
  await writeFile(
    history,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: session.sessionId,
      cwd: root,
    }) + '\n',
  );
  const originalHistory = await readFile(history, 'utf8');
  await assert.rejects(request('session/delete', { sessionId: session.sessionId }), /-32601/);
  assert.equal(await readFile(history, 'utf8'), originalHistory);
  assert.deepEqual(JSON.parse(JSON.parse(await readFile(capture, 'utf8')).mcp), servers);
  servers[0].env[0].value = 'fresh-2';
  await request('session/load', {
    sessionId: session.sessionId,
    cwd: root,
    mcpServers: servers,
  });
  const loaded = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(JSON.parse(loaded.mcp), servers);
  assert.ok(loaded.args.includes('--extension'));
  child.stdin.end();
});
