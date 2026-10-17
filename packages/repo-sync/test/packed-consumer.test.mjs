import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function npm(args, cwd) {
  const binaryDirectory = dirname(process.execPath);
  const npmCli = [
    join(binaryDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(binaryDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    process.env.npm_execpath,
  ].find((path) => path?.endsWith('npm-cli.js') && existsSync(path));
  assert.ok(npmCli, 'Node installation must include npm CLI for packed consumer verification');
  const output = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(output.status, 0, output.stderr);
  return output.stdout;
}
test('packed plugin installs in a fresh consumer and launches exact stdio and web entries without workspace links', async () => {
  const consumer = await mkdtemp(join(tmpdir(), 'repo-sync-consumer-'));
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { windowsHide: true });
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root));
  assert.equal(packed.name, '@clowder-ai/repo-sync');
  assert.ok(packed.files.some((file) => file.path === 'dist/mcp-entrypoint.mjs'));
  assert.ok(packed.files.some((file) => file.path === 'web/index.html'));
  assert.ok(
    packed.files.every(
      (file) => !['dist/text-merge.mjs', 'dist/conflicts.mjs', 'web/conflict-draft.mjs'].includes(file.path),
    ),
  );
  assert.ok(packed.files.some((file) => file.path === 'npm-shrinkwrap.json'));
  assert.ok(packed.files.every((file) => !/^(test|examples|prototype)\//.test(file.path)));
  assert.ok(
    packed.files.every(
      (file) =>
        !/(?:^|\/)(?:private|config\.json|ledger\.json|writer\.lock|sync-settings\.json|\.cat-cafe|\.repo-sync-tests)(?:\/|$)/.test(
          file.path,
        ),
    ),
  );
  assert.match(packed.filename, /^[a-z0-9.-]+\.tgz$/);
  await writeFile(join(consumer, 'package.json'), '{"private":true}\n');
  npm(['install', `./${packed.filename}`, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const installed = join(consumer, 'node_modules', '@clowder-ai', 'repo-sync');
  const config = join(consumer, 'private-config.json');
  await writeFile(
    config,
    JSON.stringify({
      sourceUrl: 'https://github.com/demo/core.git',
      internalUrl: 'git@codehub.example:team/core.git',
      sourceBranch: 'main',
      targetBranch: 'main',
      stateDir: join(consumer, 'private'),
      mode: 'version',
    }),
  );
  const cli = execFileSync(process.execPath, [join(installed, 'dist', 'cli.mjs'), 'status', config], {
    cwd: consumer,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(cli), null);
  const client = new Client({ name: 'fresh-host', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, 'dist', 'mcp-entrypoint.mjs')],
    cwd: consumer,
    env: { ...process.env, REPO_SYNC_CONFIG_FILE: join(consumer, 'first-use.json') },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (part) => {
    stderr += String(part);
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 2);
    const result = await client.callTool({ name: 'repo_sync_open_workbench', arguments: {} });
    assert.equal(result.isError, undefined, result.content[0].text);
    const { url } = JSON.parse(result.content[0].text);
    assert.match(await (await fetch(url)).text(), /同步工作台/);
    assert.equal((await fetch(new URL('/version.mjs', url))).status, 200);
    assert.equal((await fetch(new URL('/connections.mjs', url))).status, 200);
    assert.equal((await fetch(new URL('/operations.mjs', url))).status, 200);
    assert.equal((await fetch(new URL('/operation-view.mjs', url))).status, 200);
    assert.equal((await fetch(new URL('/app-shell.mjs', url))).status, 200);
    const firstUse = await (await fetch(new URL('/api/status', url))).json();
    assert.equal(firstUse.config, null);
    assert.equal(firstUse.service, 'production');
    assert.equal(existsSync(join(consumer, 'first-use.json')), false);
    await client.close();
    await assert.rejects(() => fetch(url, { signal: AbortSignal.timeout(2000) }));
    assert.doesNotMatch(stderr, /private-config|codehub|stateDir/);
  } finally {
    await client.close();
  }
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(pkg), /workspace:|file:/);
});
