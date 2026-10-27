import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const FEISHU = 'connector-feishu';
const SCOPED = {
  'plugin-contract': '@clowder-ai/plugin-contract',
  'plugin-sdk': '@clowder-ai/plugin-sdk',
  [FEISHU]: '@clowder-ai/connector-feishu',
};
const INSTALL_TIMEOUT_MS = 300_000;

async function packOfficialArtifacts(root) {
  const packs = new Map();
  const frozen = JSON.parse(await readFile(join(repoRoot, 'packages', FEISHU, 'npm-shrinkwrap.json'), 'utf8'));
  for (const name of Object.keys(SCOPED)) {
    // This fixture also runs directly via test:scripts on clean checkouts.
    // Build in dependency order; the official pack intentionally skips scripts.
    await execFileAsync('pnpm', ['--filter', SCOPED[name], 'build'], {
      cwd: repoRoot, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    const destination = join(root, 'packs', name);
    await mkdir(destination, { recursive: true });
    const pin = frozen.packages[`node_modules/${SCOPED[name]}`];
    const workspace = JSON.parse(await readFile(join(repoRoot, 'packages', name, 'package.json'), 'utf8'));
    if (pin && pin.version !== workspace.version) {
      // A new Contract/SDK candidate must not rewrite the immutable dependencies
      // of an already shipped connector. Serve its exact, integrity-checked pin.
      const url = new URL(pin.resolved);
      assert.equal(url.origin, 'https://registry.npmjs.org');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200);
      const archive = Buffer.from(await response.arrayBuffer());
      assert.ok(archive.length <= 16 * 1024 * 1024);
      const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
      assert.equal(integrity, pin.integrity, 'historical registry bytes must match the shipped lock');
      const filename = `${name}-${pin.version}.tgz`;
      const path = join(destination, filename);
      await writeFile(path, archive);
      packs.set(SCOPED[name], { archive, filename, integrity, path, version: pin.version });
      continue;
    }
    const { stdout } = await execFileAsync(process.execPath, [
      join('scripts', 'pack-publish-artifact.mjs'),
      `packages/${name}`,
      destination,
    ], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const [artifact] = JSON.parse(stdout);
    const path = join(destination, artifact.filename);
    const archive = await readFile(path);
    packs.set(SCOPED[name], {
      archive,
      filename: artifact.filename,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      path,
      version: artifact.version,
    });
  }
  return packs;
}

function registryFixture(t, packs) {
  for (const [name, release] of packs) {
    release.tarballPath = `/${name}/-/${name.split('/').at(-1)}-${release.version}.tgz`;
  }
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const packument = [...packs].find(([name]) => request.url === `/${name.replace('/', '%2f')}`);
    if (packument) {
      const [name, release] = packument;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name,
        'dist-tags': { latest: release.version },
        versions: {
          [release.version]: {
            name,
            version: release.version,
            dist: {
              integrity: release.integrity,
              tarball: `${origin}${release.tarballPath}`,
            },
          },
        },
      }));
      return;
    }
    const tarball = [...packs].find(([, release]) =>
      request.url === release.tarballPath);
    if (tarball) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball[1].archive);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(async () => {
        await new Promise((done) => server.close(done));
      });
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function feishuConsumer(root, registry, packs) {
  // The consumer is the UNPACKED publish artifact — not a copy of the worktree —
  // so the install chain under test is exactly what a Host would receive.
  const release = packs.get(SCOPED[FEISHU]);
  const consumer = join(root, 'consumer');
  await mkdir(consumer, { recursive: true });
  await execFileAsync('tar', ['-xzf', release.path, '-C', consumer], { timeout: 60_000 });
  const packageRoot = join(consumer, 'package');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  // The published devDependencies are not part of the shrinkwrap; dropping them
  // is the consumer install context only — the artifact bytes stay untouched.
  delete manifest.devDependencies;
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
  const shrinkwrap = JSON.parse(await readFile(join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'));
  for (const [key, entry] of Object.entries(shrinkwrap.packages)) {
    const pack = packs.get(entry.name ?? key.replace(/^node_modules\//u, ''));
    // The shipped lock can retain an older immutable SDK than this workspace.
    // Only redirect versions whose exact archive is served by this registry.
    if (key.startsWith('node_modules/@clowder-ai/') && pack && entry.version === pack.version) {
      const resolved = new URL(entry.resolved);
      assert.equal(resolved.origin, 'https://registry.npmjs.org');
      // Preserve the shipped pathname: replacing it with npm pack's local
      // filename would hide a broken registry URL inside the real artifact.
      entry.resolved = `${registry}${resolved.pathname}${resolved.search}`;
    }
  }
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap, null, 2));
  return packageRoot;
}

async function npmCi(consumer, cacheDir) {
  return execFileAsync('npm', [
    'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
    '--cache', cacheDir,
  ], { cwd: consumer, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

async function installedVersion(consumer, name) {
  return JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8')).version;
}

test('official feishu artifact installs its full dependency chain through a registry with integrity enforced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-feishu-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packs = await packOfficialArtifacts(root);
  const registry = await registryFixture(t, packs);
  const consumer = await feishuConsumer(root, registry, packs);
  // A shared npm cache would serve the original tarball bytes again after the
  // tamper step below, defeating the integrity assertion; isolate per install.
  const caches = [await mkdtemp(join(root, 'npm-cache-a-')), await mkdtemp(join(root, 'npm-cache-b-'))];

  await npmCi(consumer, caches[0]);

  assert.equal(await installedVersion(consumer, '@clowder-ai/plugin-contract'), '0.3.0');
  assert.equal(await installedVersion(consumer, '@clowder-ai/plugin-sdk'), '0.3.0-beta.1');
  const contract = packs.get('@clowder-ai/plugin-contract');
  const shrinkwrap = JSON.parse(await readFile(join(consumer, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(
    shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract'].integrity,
    contract.integrity,
    'the registry-served bytes are the official publish artifact pinned by the shrinkwrap',
  );

  const probe = async (script, ...args) => execFileAsync(process.execPath, ['--input-type=module', '-e', script, ...args], {
    cwd: consumer, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  // The manifest under test is the one shipped inside the artifact; the probe
  // itself runs only against installed dependencies.
  const manifestJson = join(root, 'manifest.json');
  await writeFile(manifestJson, JSON.stringify(parseYaml(await readFile(join(consumer, 'plugin.yaml'), 'utf8'))));
  await probe(
    "const m = await import('@clowder-ai/plugin-contract/variant');"
    + "if (typeof m.coerceStoredValues !== 'function') throw new Error('variant export missing');",
  );
  const entrypoint = join(consumer, 'dist', 'plugin-entrypoint.js');
  await probe(
    "const [manifestPath, entrypointPath] = process.argv.slice(1);"
    + "const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));"
    + "const contract = await import('@clowder-ai/plugin-contract');"
    + "const validation = contract.validateManifest(manifest);"
    + "if (!validation.valid) throw new Error('manifest rejected: ' + JSON.stringify(validation.errors));"
    + "const m = await import(entrypointPath);"
    + "const plugin = m.default.create(validation.manifest);"
    + "if (typeof plugin.start !== 'function') throw new Error('start missing');"
    + "if (typeof plugin.settings !== 'function') throw new Error('settings missing');",
    manifestJson,
    entrypoint,
  );

  // Exercise the documented packed mode against the same real installed
  // artifact, so source-only runs cannot hide stale package/SDK expectations.
  const packedRoots = Object.fromEntries(
    ['feishu', 'dingtalk', 'telegram', 'wecom-agent', 'wecom-bot', 'weixin', 'xiaoyi']
      .map(name => [name, name === 'feishu' ? consumer : join(root, `unused-${name}`)]),
  );
  const packedEnv = { ...process.env, CLOWDER_CONNECTOR_PACKED_ROOTS: JSON.stringify(packedRoots) };
  delete packedEnv.NODE_TEST_CONTEXT;
  const packedResult = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern=^feishu packed entrypoint',
    'scripts/connector-command-entrypoints.test.mjs',
  ], {
    cwd: repoRoot, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: packedEnv,
  });
  assert.match(packedResult.stdout, /^ok \d+ - feishu packed entrypoint /mu);

  // A local npm pack filename is not a registry tarball basename. Keep each
  // wrong URL in the lock and prove npm itself rejects it, with a fresh cache.
  const shrinkwrapPath = join(consumer, 'npm-shrinkwrap.json');
  const validLock = await readFile(shrinkwrapPath, 'utf8');
  for (const name of ['plugin-contract', 'plugin-sdk']) {
    await t.test(`registry rejects scope-prefixed local filename for ${name}`, async () => {
      const wrongLock = JSON.parse(validLock);
      const key = `node_modules/@clowder-ai/${name}`;
      const entry = wrongLock.packages[key];
      const url = new URL(entry.resolved);
      url.pathname = url.pathname.replace('/-/', '/-/clowder-ai-');
      entry.resolved = url.href;
      await writeFile(shrinkwrapPath, JSON.stringify(wrongLock, null, 2));
      await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
      const cache = await mkdtemp(join(root, 'npm-cache-wrong-url-'));
      try {
        await assert.rejects(npmCi(consumer, cache), (error) => {
          const output = `${error.stderr}\n${error.stdout}`;
          // Public mirrors may reject an invalid tarball basename before lookup.
          assert.match(output, /E(?:404|422)\b/u, output);
          assert.ok(output.includes(url.pathname), output);
          return true;
        });
      } finally {
        await writeFile(shrinkwrapPath, validLock);
      }
    });
  }

  // Alter gzip MTIME while keeping a valid archive and identical unpacked tar.
  // Corrupting compressed data races zlib failure against SRI verification;
  // this isolates the promised byte-integrity check on every platform.
  const tampered = Buffer.from(contract.archive);
  tampered[4] ^= 1;
  assert.deepEqual(gunzipSync(tampered), gunzipSync(contract.archive));
  assert.notEqual(
    `sha512-${createHash('sha512').update(tampered).digest('base64')}`,
    contract.integrity,
  );
  packs.get('@clowder-ai/plugin-contract').archive = tampered;
  await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
  await assert.rejects(npmCi(consumer, caches[1]), (error) => {
    const output = `${error.stderr}\n${error.stdout}`;
    assert.match(output, /EINTEGRITY/u, output);
    return true;
  });
});
