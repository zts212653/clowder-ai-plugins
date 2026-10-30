import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import register from '../dist/native-mcp-extension.mjs';
import { MCP_ENV, preparePiMcp, toNativeServer, validateServers } from '../dist/session-mcp.mjs';

const stdio = {
  name: 'cat-cafe-collab',
  command: process.execPath,
  args: ['collab.js', 'two words'],
  env: [{ name: 'CALLBACK_FILE', value: 'fresh-file' }],
};
test('native registration retains argv, credentials and direct tool exposure without changing parent environment', () => {
  const previous = process.env[MCP_ENV];
  const result = preparePiMcp([stdio], '/test');
  assert.equal(process.env[MCP_ENV], previous);
  assert.equal(result.args[0], '--extension');
  assert.deepEqual(toNativeServer(stdio, '/test'), {
    command: process.execPath,
    args: stdio.args,
    env: { CALLBACK_FILE: 'fresh-file' },
    cwd: '/test',
    exposure: 'direct',
  });
  assert.deepEqual(
    toNativeServer({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'session' }],
    }),
    {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'session' },
      exposure: 'direct',
    },
  );
});
test('rejects malformed, oversized, colliding and unsupported server declarations', () => {
  for (const servers of [
    null,
    Array(33).fill(stdio),
    [{ ...stdio, args: [null] }],
    [{ ...stdio, name: '../bad' }],
    [stdio, { ...stdio, name: 'cat_cafe_collab' }],
    [{ name: 'sse', type: 'sse', url: 'https://example.test' }],
    [{ ...stdio, env: [{ name: 'A', value: 'x'.repeat(65536) }] }],
  ]) {
    assert.throws(() => validateServers(servers));
  }
});
test('extension registers session servers and removes transport environment after consumption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = {
    payload: process.env[MCP_ENV],
    cwd: process.env.CLOWDER_PI_ACP_CWD,
    home: process.env.PI_CODING_AGENT_DIR,
  };
  t.after(() => {
    for (const [name, value] of [
      [MCP_ENV, previous.payload],
      ['CLOWDER_PI_ACP_CWD', previous.cwd],
      ['PI_CODING_AGENT_DIR', previous.home],
    ])
      value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  process.env[MCP_ENV] = JSON.stringify([stdio]);
  process.env.CLOWDER_PI_ACP_CWD = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const registrations = [];
  register({
    registerMcpServer: (name, config) => registrations.push([name, config]),
  });
  assert.equal(registrations[0][0], 'cat-cafe-collab');
  assert.equal(process.env[MCP_ENV], undefined);
  assert.equal(registrations[0][1].cwd, root);
});
test('unsupported native Pi and saved config collisions fail closed with actionable stderr', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = new URL('../dist/native-mcp-extension.mjs', import.meta.url).href;
  const run = (api) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import register from ${JSON.stringify(extension)}; register(${api});`],
      {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: root,
          CLOWDER_PI_ACP_CWD: root,
          [MCP_ENV]: JSON.stringify([stdio]),
        },
      },
    );
  const oldPi = run('{}');
  assert.equal(oldPi.status, 64);
  assert.match(oldPi.stderr, /Pi 1.3/);
  await mkdir(join(root, '.pi'));
  await writeFile(
    join(root, '.pi', 'mcp.json'),
    JSON.stringify({ mcpServers: { cat_cafe_collab: { command: 'stale' } } }),
  );
  const collision = run('{registerMcpServer(){throw Error("must not register")}}');
  assert.equal(collision.status, 64);
  assert.match(collision.stderr, /Remove duplicate ACP MCP/);
});

test('saved server collisions use the same tilde, file URL and Windows drive roots as native Pi', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { 'cat-cafe-collab': { command: 'stale' } } }),
  );
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { 'cat-cafe-collab': { command: 'stale' } } }));
  const aliases = ['~', '~/agent', pathToFileURL(agentDir).href];
  if (process.platform === 'win32') {
    const shellPath = agentDir.replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
    aliases.push('~\\agent', shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`);
  }
  const extension = new URL('../dist/native-mcp-extension.mjs', import.meta.url).href;
  for (const alias of aliases) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import register from ${JSON.stringify(extension)}; register({registerMcpServer(){}});`,
      ],
      {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          PI_CODING_AGENT_DIR: alias,
          CLOWDER_PI_ACP_CWD: root,
          [MCP_ENV]: JSON.stringify([stdio]),
        },
      },
    );
    assert.equal(result.status, 64, alias);
    assert.match(result.stderr, /Remove duplicate ACP MCP/, alias);
  }
});
