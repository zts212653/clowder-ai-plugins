import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024, ...extra });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}

test('a locked music archive runs its module and native MCP outside the workspace, without Cloud credentials', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'music-installed-'));
  try {
    const packs = join(temporary, 'packs');
    const consumer = join(temporary, 'consumer');
    await mkdir(packs); await mkdir(consumer);
    const [artifact] = JSON.parse(run(process.execPath,
      ['scripts/pack-publish-artifact.mjs', 'packages/music-generation', packs], repository));
    assert.ok(artifact.files.some(file => file.path === 'dist/oauth-receiver.js'));
    assert.ok(artifact.files.some(file => file.path === 'npm-shrinkwrap.json'));
    run('tar', ['-xzf', join(packs, artifact.filename), '-C', consumer], temporary);
    const installed = join(consumer, 'package');
    const npmCli = process.env.CLOWDER_ARTIFACT_NPM_CLI;
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    run(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...npmArgs] : npmArgs, installed);
    assert.equal((await lstat(join(installed, 'node_modules/@clowder-ai/plugin-sdk'))).isSymbolicLink(), false);
    const sdk = JSON.parse(await readFile(join(installed, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
    assert.equal(sdk.version, '0.2.0-beta.24', 'the consumer uses the available immutable SDK, not the local candidate');
    const check = join(consumer, 'check.mjs');
    await writeFile(check, `import assert from 'node:assert/strict';\nconst { default: plugin } = await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/plugin-entrypoint.js')).href)});\nassert.equal(typeof plugin.create, 'function');\nconst hooks = plugin.create({});\nassert.equal(typeof hooks.settings, 'function');\nassert.equal(typeof hooks.preUninstall, 'function');\n`);
    // An empty child environment supplies neither ambient ADC nor a borrowed Host or CLI identity.
    run(process.execPath, [check], consumer, { env: {} });
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_music', arguments: {} } },
    ];
    const replies = run(process.execPath, [join(installed, 'dist/mcp-entrypoint.js')], consumer,
      { env: {}, input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n' })
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length, 3, 'MCP stdout contains only protocol replies');
    assert.equal(replies.find(reply => reply.id === 2).result.tools[0].name, 'generate_music');
    assert.equal(replies.find(reply => reply.id === 3).result.isError, true,
      'an unbound native invocation is refused; discovery never generates music');
    console.log(JSON.stringify({ artifact: artifact.filename, integrity: artifact.integrity,
      installedSdk: sdk.version, cloudRequests: 0 }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
