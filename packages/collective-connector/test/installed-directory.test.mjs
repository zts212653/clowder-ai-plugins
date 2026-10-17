import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = join(root, 'packages/collective-connector');
function run(command, args, cwd) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  if (command === 'tar') env.COPYFILE_DISABLE = '1';
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, [command, ...args, result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('local directory installs into an empty consumer and runs the real SDK lifecycle', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'collective-directory-consumer-'));
  try {
    const artifacts = join(temporary, 'artifacts');
    const consumer = join(temporary, 'consumer');
    await mkdir(artifacts); await mkdir(consumer);
    const packages = ['plugin-contract', 'plugin-sdk', 'collective-connector'];
    const packed = [];
    for (const name of packages) {
      run('pnpm', ['--filter', '@clowder-ai/' + name, 'build'], root);
      const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], join(root, 'packages', name)));
      assert.equal(result.length, 1);
      packed.push(join(artifacts, result[0].filename));
      console.log(JSON.stringify({ packed: result[0].filename, shasum: result[0].shasum, integrity: result[0].integrity }));
      if (name === 'collective-connector') {
        assert.ok(result[0].files.some(file => file.path === 'plugin.yaml'));
        assert.ok(result[0].files.some(file => file.path === 'dist/plugin-entrypoint.js'));
        assert.ok(result[0].files.some(file => file.path === 'skills/collective-participation/SKILL.md'));
      }
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(consumer, 'manifest.json'), JSON.stringify(parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'))));
    await cp(new URL('./installed-consumer-journey.mjs', import.meta.url), join(consumer, 'journey.mjs'));
    // SDK and contract are exact local artifacts: neither needs to be published.
    run('npm', ['install', '--ignore-scripts', '--install-links', '--no-audit', '--no-fund', '--package-lock=false',
      '--registry=https://registry.npmjs.org', packageRoot, ...packed.slice(0, 2)], consumer);
    console.log(run(process.execPath, ['journey.mjs'], consumer).trim());
    if (process.env.F202_COLLECTIVE_HOST_ROOT || process.env.F202_COLLECTIVE_ARTIFACT_DIR) {
      const candidate = join(temporary, 'host-candidate');
      const installedRoot = join(consumer, 'node_modules/@clowder-ai/collective-connector');
      await cp(installedRoot, candidate, { recursive: true });
      await cp(join(consumer, 'node_modules'), join(candidate, 'node_modules'), {
        recursive: true, dereference: true, filter: source => source !== installedRoot,
      });
      if (process.env.F202_COLLECTIVE_ARTIFACT_DIR) {
        const destination = process.env.F202_COLLECTIVE_ARTIFACT_DIR;
        await mkdir(destination, { recursive: true });
        for (const path of packed) await cp(path, join(destination, path.slice(path.lastIndexOf('/') + 1)));
        const archive = join(destination, 'collective-connector-self-contained.tgz');
        const release = join(temporary, 'release');
        await mkdir(release);
        await cp(candidate, join(release, 'package'), { recursive: true });
        run('tar', ['-czf', archive, '-C', release, 'package'], root);
        const bytes = await readFile(archive);
        console.log(JSON.stringify({ materializedArchive: archive, sha256: createHash('sha256').update(bytes).digest('hex'),
          shasum: createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }));
      }
      if (process.env.F202_COLLECTIVE_HOST_ROOT) console.log(run(process.execPath, [fileURLToPath(new URL('./host-directory-journey.mjs', import.meta.url)),
        process.env.F202_COLLECTIVE_HOST_ROOT, candidate], root).trim());
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
