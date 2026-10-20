import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionDependencyClosure } from './catalog-package-shrinkwrap.mjs';
import { normalizeBundledPublishGzip } from './canonical-publish-gzip.mjs';
import { assertArchiveBins } from './package-bins.mjs';
import { materializeLockedDependencies } from './materialize-locked-dependencies.mjs';
import { ownPublishMembers } from './own-publish-members.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  }
  return result.stdout;
}

function runNpm(args, cwd) {
  const npmCli = process.env.CLOWDER_ARTIFACT_NPM_CLI;
  if (npmCli === undefined) return run('npm', args, cwd);
  if (!isAbsolute(npmCli)) {
    throw new Error('CLOWDER_ARTIFACT_NPM_CLI must be an absolute path');
  }
  return run(process.execPath, [npmCli, ...args], cwd);
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function readPnpmArtifact(output) {
  const artifact = JSON.parse(output);
  if (
    artifact === null ||
    Array.isArray(artifact) ||
    typeof artifact !== 'object' ||
    typeof artifact.filename !== 'string' ||
    typeof artifact.name !== 'string' ||
    typeof artifact.version !== 'string' ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('pnpm pack did not report one materialized artifact');
  }
  return artifact;
}

function assertCanonicalArchiveMembers(output) {
  const members = output.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error('materialized package archive is empty');
  for (const member of members) {
    const normalized = posix.normalize(member.replace(/\/$/u, ''));
    if (
      member.includes('\\') ||
      isAbsolute(member) ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      (normalized !== 'package' && !normalized.startsWith('package/'))
    ) {
      throw new Error(`materialized package archive has an unsafe member: ${member}`);
    }
  }
}

async function assertPhysicalTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`materialized package contains a symlink: ${relative(root, path)}`);
      }
      if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) {
        throw new Error(`materialized package contains a non-regular entry: ${relative(root, path)}`);
      }
    }
  }
}

async function main() {
  const [packageDirectory, destination] = process.argv.slice(2);
  if (!/^packages\/[a-z0-9-]+$/u.test(packageDirectory ?? '')) {
    throw new Error('package directory must be a repository-relative packages/<name> path');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('pack destination is required');
  }

  const packageRoot = resolve(repoRoot, packageDirectory);
  const destinationRoot = resolve(destination);
  if (!isContained(resolve(repoRoot, 'packages'), packageRoot)) {
    throw new Error('package directory escapes the public package root');
  }
  await mkdir(destinationRoot, { recursive: true });

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const bundled = packageJson.bundledDependencies;
  if (bundled === undefined || (Array.isArray(bundled) && bundled.length === 0)) {
    try {
      const shrinkwrap = JSON.parse(
        await readFile(join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'),
      );
      assertProductionDependencyClosure(packageJson, shrinkwrap);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Core libraries can be ordinary npm packages. A plugin, including a
      // private module or editor provider, must also be materializable by Host.
      // Installing it beside workspace dependencies is not an installation closure.
      if (Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies }).length > 0) {
        let plugin = false;
        try {
          await readFile(join(packageRoot, 'plugin.yaml'));
          plugin = true;
        } catch (manifestError) {
          if (manifestError?.code !== 'ENOENT') throw manifestError;
        }
        if (plugin) throw new Error(`${packageJson.name}: plugin runtime dependencies require npm-shrinkwrap.json`);
      }
    }
    const output = runNpm(
        ['pack', '--json', '--ignore-scripts', '--pack-destination', destinationRoot, packageRoot],
        repoRoot,
    );
    const [artifact] = JSON.parse(output);
    assertArchiveBins(packageJson, join(destinationRoot, artifact.filename));
    process.stdout.write(output);
    return;
  }
  if (!Array.isArray(bundled) || !bundled.every(name => typeof name === 'string')) {
    throw new Error('bundledDependencies must be an explicit package-name array');
  }
  const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
  const bundledNames = [...bundled].sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(bundledNames)) {
    throw new Error('runtime package must bundle its complete declared dependency closure');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-pack-closure-'));
  try {
    const sourceRoot = join(temporaryRoot, 'source');
    await mkdir(sourceRoot);
    const deploymentRoot = join(temporaryRoot, 'deployment');
    const ownMembers = new Map();
    async function copyPublishPackage(source, target) {
      let members = ownMembers.get(source);
      if (!members) {
        members = (await ownPublishMembers(source, { runNpm })).filter(path =>
          isContained(source, resolve(source, path)));
        ownMembers.set(source, members);
      }
      for (const member of members) {
        const from = join(source, member);
        if (!(await lstat(from)).isFile()) throw new Error(`non-regular own publish member: ${member}`);
        const to = join(target, member);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      }
    }
    await copyPublishPackage(packageRoot, deploymentRoot);
    await materializeLockedDependencies({ repoRoot, packageRoot, destination: deploymentRoot,
      copyPublishPackage });
    const pnpmOutput = run(
      'pnpm',
      [
        '--config.ignore-scripts=true',
        '--config.node-linker=hoisted',
        'pack',
        '--json',
        '--pack-destination',
        destinationRoot,
      ],
      deploymentRoot,
    );
    const materialized = readPnpmArtifact(pnpmOutput);
    const archivePath = resolve(packageRoot, materialized.filename);
    if (!isContained(destinationRoot, archivePath)) {
      throw new Error('pnpm pack artifact escaped its requested destination');
    }
    assertCanonicalArchiveMembers(run('tar', ['-tzf', archivePath], repoRoot));
    run('tar', ['-xzf', archivePath, '-C', sourceRoot], repoRoot);

    const stagedPackageRoot = join(sourceRoot, 'package');
    await assertPhysicalTree(stagedPackageRoot);
    const packedBytes = await readFile(archivePath);
    assertArchiveBins(packageJson, archivePath);
    const bytes = normalizeBundledPublishGzip(packedBytes);
    if (!bytes.equals(packedBytes)) await writeFile(archivePath, bytes);
    process.stdout.write(`${JSON.stringify([{
      ...materialized,
      filename: basename(archivePath),
      size: bytes.byteLength,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    }], null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
