import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';
import { validateManifest } from '../../plugin-contract/dist/index.js';

const root = resolve(import.meta.dirname, '..');
function pack(source, output) {
  mkdirSync(output, { recursive: true });
  const [result] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
      {
        cwd: source,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  return { path: join(output, result.filename), integrity: result.integrity };
}

test(
  'independent npm packs have identical bytes and a fresh locked consumer serves read-only and separately authorized workspace tools',
  { timeout: 120000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tripo-published-consumer-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const copy = join(directory, 'independent', 'source');
    cpSync(root, copy, {
      recursive: true,
      filter: (path) => !path.split('/').includes('node_modules'),
    });
    const first = pack(root, join(directory, 'first'));
    const second = pack(copy, join(directory, 'second'));
    assert.equal(first.integrity, second.integrity);
    const bytes = readFileSync(first.path);
    assert.deepEqual(
      bytes,
      readFileSync(second.path),
      'moving the package source cannot change tar bytes or SRI',
    );
    assert.equal(
      first.integrity,
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    );
    const consumer = join(directory, 'consumer');
    mkdirSync(consumer);
    execFileSync('tar', ['-xzf', first.path, '-C', consumer]);
    const installed = join(consumer, 'package');
    const lockPath = join(installed, 'npm-shrinkwrap.json');
    const lockBytes = readFileSync(lockPath);
    const manifest = parse(
      readFileSync(join(installed, 'plugin.yaml'), 'utf8'),
    );
    const admission = validateManifest(manifest);
    assert.equal(admission.valid, true, JSON.stringify(admission));
  const loaded = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import entry from './${manifest.runtime.entrypoint}';
    const module = entry.create(${JSON.stringify(manifest)});
    const settings = await module.settings({});
    const result = await settings.actions['tripo.status']({ input: {} });
    await settings.dispose();
    const active = await module.start({});
    await active.stop({ reason: 'disabled' });
    console.log(JSON.stringify(result));
  `], { cwd: installed, encoding: 'utf8', env: { ...process.env, HOME: consumer } }));
  assert.equal(loaded.data.artifact.version, manifest.version);
  assert.equal(loaded.data.auth.status, 'unverified');
  assert.equal(loaded.data.live.status, 'dormant');
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.lockfileVersion, 3);
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      assert.ok(
        path.startsWith('node_modules/'),
        'all dependency entries must belong to this package',
      );
      assert.equal(
        entry.link,
        undefined,
        'published closure cannot depend on workspace symlinks',
      );
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
      assert.match(entry.integrity, /^sha512-/);
    }
    execFileSync(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--workspaces=false',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: installed,
        encoding: 'utf8',
        timeout: 90000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.deepEqual(
      readFileSync(lockPath),
      lockBytes,
      'consumer materialization keeps publisher lock bytes',
    );
    const client = new Client(
      { name: 'tripo-plugin-consumer', version: '1' },
      { capabilities: {} },
    );
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(installed, manifest.contributions[0].runtime.entrypoint)],
        cwd: installed,
        env: { PATH: process.env.PATH, HOME: consumer },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 11);
    const status = await client.callTool({
      name: 'tripo_status',
      arguments: {},
    });
    assert.equal(
      status.structuredContent.artifact.version,
      JSON.parse(readFileSync(join(installed, 'package.json'))).version,
    );
    assert.equal(status.structuredContent.auth.status, 'unverified');
    const invalid = await client.callTool({
      name: 'tripo_review_shared_model',
      arguments: { url: 'http://127.0.0.1/private', number: 1 },
    });
    assert.equal(invalid.isError, true);
    const prepared = await client.callTool({
      name: 'tripo_prepare_chrome',
      arguments: {},
    });
    assert.equal(prepared.isError, undefined);
    assert.equal(prepared.structuredContent.artifact.installed, true);
    await client.close();
  },
);
